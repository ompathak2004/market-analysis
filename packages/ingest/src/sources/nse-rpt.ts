import { sha256 } from "@ma/core";
import { normalizeCompanyName } from "../extract/relationships.js";
import type { HttpClient } from "../http.js";
import {
  contextGroups,
  factOf,
  headerFact,
  INTEGRATED_FINANCIALS,
  inrToCrore,
  integratedFilingsUrl,
  isoDay,
  jsonRows,
  latestFirst,
  type NseRequest,
  nseGet,
  nseTimestamp,
  parseIntegratedFilings,
  str,
  xbrlContexts,
} from "./nse-xbrl.js";

export const NSE_RPT_PARSER_VERSION = 1;

export interface RptFiling {
  id: string;
  kind: "integrated" | "legacy";
  symbol: string;
  companyName: string;
  periodStart: string | null;
  periodEnd: string;
  submittedAt: Date | null;
  revised: boolean;
  xbrlUrl: string;
}

export interface RptRow {
  entity: string;
  counterparty: string;
  relationship: string | null;
  transactionType: string | null;
  valueCr: number | null;
}

export interface RptReport {
  symbol: string | null;
  companyName: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  rows: RptRow[];
}

export interface RptAggregate {
  key: string;
  entity: string;
  scope: "listed" | "subsidiary";
  counterparty: string;
  relationship: string | null;
  transactionType: string | null;
  valueCr: number | null;
  rows: number;
}

export interface RptSnapshot {
  content: string;
  spans: Map<string, { start: number; end: number }>;
}

export function parseRptMaster(json: string): RptFiling[] {
  return jsonRows(json, "related party master").flatMap((r) => {
    const xbrlUrl = str(r.xbrlLink) ?? str(r.xbrl);
    const periodEnd = isoDay(str(r.periodEndDate) ?? str(r.toDate));
    const symbol = str(r.rptSymbol) ?? str(r.symbol);
    if (!xbrlUrl || !/^https?:\/\//.test(xbrlUrl) || !periodEnd || !symbol) return [];
    return [
      {
        id: str(r.seqNum) ?? xbrlUrl,
        kind: "legacy" as const,
        symbol,
        companyName: str(r.rptCompName) ?? str(r.rptCompanyName) ?? symbol,
        periodStart: isoDay(str(r.rptReportingPeriodSt) ?? str(r.fromDate)),
        periodEnd,
        submittedAt: nseTimestamp(r.submissionDate) ?? nseTimestamp(r.TimeStamp),
        revised: Boolean(str(r.rptRevDate)) || /revis/i.test(str(r.rptSubmissionType) ?? ""),
        xbrlUrl,
      },
    ];
  });
}

export function isHalfYearEnd(periodEnd: string): boolean {
  const month = periodEnd.slice(5, 7);
  return month === "03" || month === "09";
}

export function parseIntegratedRpt(json: string): RptFiling[] {
  return parseIntegratedFilings(json).flatMap((f) => {
    if (f.type && f.type !== INTEGRATED_FINANCIALS) return [];
    if (f.standalone === false || !isHalfYearEnd(f.periodEnd)) return [];
    return [
      {
        id: f.seqId,
        kind: "integrated" as const,
        symbol: f.symbol,
        companyName: f.companyName,
        periodStart: null,
        periodEnd: f.periodEnd,
        submittedAt: f.submittedAt,
        revised: f.revised,
        xbrlUrl: f.xbrlUrl,
      },
    ];
  });
}

export function parseRptXbrl(xml: string): RptReport {
  const contexts = xbrlContexts(xml);
  const rows: RptRow[] = [];
  for (const ids of contextGroups(contexts, "RelatedPartyTransaction").values()) {
    const fact = (name: string) => factOf(contexts, ids, name);
    const counterparty = fact("NameOfCounterParty");
    if (!counterparty) continue;
    const type = fact("TypeOfRelatedPartyTransaction");
    const details = fact("DetailsOfOtherRelatedPartyTransaction");
    const amount = ids
      .map((id) => contexts.get(id)?.get("AmountOfRelatedPartyTransactionDuringTheReportingPeriod"))
      .find(Boolean);
    rows.push({
      entity: fact("NameOfListedEntityOrSubsidiaryEnteringIntoTheTransaction") ?? "",
      counterparty,
      relationship: fact("RelationshipOfTheCounterpartyWithTheListedEntityOrItsSubsidiary"),
      transactionType: type && /any\s+other/i.test(type) && details ? details : (type ?? details),
      valueCr: inrToCrore(amount),
    });
  }
  return {
    symbol: headerFact(contexts, "NSESymbol") ?? headerFact(contexts, "Symbol"),
    companyName: headerFact(contexts, "NameOfTheCompany"),
    periodStart: isoDay(headerFact(contexts, "DateOfStartOfReportingPeriod")),
    periodEnd: isoDay(headerFact(contexts, "DateOfEndOfReportingPeriod")),
    rows,
  };
}

const lower = (s: string | null) => (s ?? "").replace(/\s+/g, " ").trim().toLowerCase();

export function aggregateRpt(report: RptReport, companyName: string): RptAggregate[] {
  const listed = normalizeCompanyName(companyName);
  const out = new Map<string, RptAggregate>();
  for (const row of report.rows) {
    const entity = row.entity || companyName;
    const scope = normalizeCompanyName(entity) === listed ? "listed" : "subsidiary";
    const key = sha256(
      [
        normalizeCompanyName(entity),
        normalizeCompanyName(row.counterparty),
        lower(row.relationship),
        lower(row.transactionType),
      ].join("|"),
    ).slice(0, 32);
    const prev = out.get(key);
    if (prev) {
      prev.rows += 1;
      if (row.valueCr != null) prev.valueCr = round2((prev.valueCr ?? 0) + row.valueCr);
      continue;
    }
    out.set(key, {
      key,
      entity,
      scope,
      counterparty: row.counterparty,
      relationship: row.relationship,
      transactionType: row.transactionType,
      valueCr: row.valueCr,
      rows: 1,
    });
  }
  return [...out.values()].sort((a, b) => a.key.localeCompare(b.key));
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function rptSnapshot(
  filing: RptFiling,
  report: RptReport,
  aggregates: readonly RptAggregate[],
): RptSnapshot {
  const head = JSON.stringify({
    source: "nse_rpt",
    parserVersion: NSE_RPT_PARSER_VERSION,
    filing: {
      id: filing.id,
      kind: filing.kind,
      periodStart: report.periodStart ?? filing.periodStart,
      periodEnd: report.periodEnd ?? filing.periodEnd,
      submittedAt: filing.submittedAt?.toISOString() ?? null,
      revised: filing.revised,
      url: filing.xbrlUrl,
    },
    company: {
      symbol: report.symbol ?? filing.symbol,
      name: report.companyName ?? filing.companyName,
    },
  });
  const spans = new Map<string, { start: number; end: number }>();
  let content = `${head.slice(0, -1)},"transactions":[\n`;
  aggregates.forEach((a, i) => {
    const line = JSON.stringify({
      entity: a.entity,
      scope: a.scope,
      counterparty: a.counterparty,
      relationship: a.relationship,
      type: a.transactionType,
      valueCr: a.valueCr,
      rows: a.rows,
    });
    spans.set(a.key, { start: content.length, end: content.length + line.length });
    content += line + (i < aggregates.length - 1 ? ",\n" : "\n");
  });
  content += "]}";
  return { content, spans };
}

export class NseRptSource {
  private readonly req: NseRequest;

  constructor(http: HttpClient, baseUrl: string) {
    this.req = {
      http,
      baseUrl,
      referer: "/companies-listing/corporate-filings-related-party-transactions",
    };
  }

  async filings(symbol: string, signal?: AbortSignal): Promise<RptFiling[]> {
    const [a, b] = await Promise.allSettled([
      this.integrated(symbol, signal),
      this.legacy(symbol, signal),
    ]);
    if (a.status === "rejected" && b.status === "rejected") throw a.reason;
    return latestFirst([
      ...(a.status === "fulfilled" ? a.value : []),
      ...(b.status === "fulfilled" ? b.value : []),
    ]);
  }

  async report(filing: RptFiling, signal?: AbortSignal): Promise<RptReport> {
    const xml = await nseGet(this.req, filing.xbrlUrl, signal, "application/xml, text/xml, */*");
    return parseRptXbrl(xml);
  }

  private async integrated(symbol: string, signal?: AbortSignal) {
    const url = integratedFilingsUrl(this.req.baseUrl, symbol, INTEGRATED_FINANCIALS);
    return parseIntegratedRpt(
      await nseGet(
        { ...this.req, referer: "/companies-listing/corporate-integrated-filing" },
        url,
        signal,
      ),
    );
  }

  private async legacy(symbol: string, signal?: AbortSignal) {
    const url = `${this.req.baseUrl}/api/related-party-transactions-master?index=equities&symbol=${encodeURIComponent(symbol)}`;
    return parseRptMaster(await nseGet(this.req, url, signal));
  }
}
