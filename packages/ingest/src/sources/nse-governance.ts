import type { HttpClient } from "../http.js";
import {
  contextGroups,
  factOf,
  headerFact,
  INTEGRATED_GOVERNANCE,
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

export const NSE_GOVERNANCE_PARSER_VERSION = 1;

export type DirectorRole =
  | "director"
  | "independent_director"
  | "md"
  | "ceo"
  | "cfo"
  | "chairman"
  | "promoter"
  | "kmp"
  | "other";

export interface GovernanceFiling {
  id: string;
  kind: "integrated" | "legacy";
  symbol: string;
  companyName: string;
  periodEnd: string;
  submittedAt: Date | null;
  revised: boolean;
  xbrlUrl: string;
}

export interface GovernanceDirector {
  din: string | null;
  name: string;
  title: string | null;
  category: string | null;
  role: DirectorRole;
  independent: boolean;
  executive: boolean;
  promoterRelated: boolean;
  birthYear: number | null;
  status: "current" | "past";
  appointedOn: string | null;
  reappointedOn: string | null;
  ceasedOn: string | null;
}

export interface GovernanceReport {
  symbol: string | null;
  isin: string | null;
  companyName: string | null;
  periodEnd: string | null;
  directors: GovernanceDirector[];
}

export interface GovernanceSnapshot {
  content: string;
  spans: Map<string, { start: number; end: number }>;
}

export function parseGovernanceMaster(json: string): GovernanceFiling[] {
  return jsonRows(json, "corporate governance master").flatMap((r) => {
    const xbrlUrl = str(r.xbrl);
    const periodEnd = isoDay(str(r.date) ?? str(r.quarterEndDate));
    const symbol = str(r.symbol);
    if (!xbrlUrl || !/^https?:\/\//.test(xbrlUrl) || !periodEnd || !symbol) return [];
    return [
      {
        id: str(r.recordId) ?? str(r.recId) ?? xbrlUrl,
        kind: "legacy" as const,
        symbol,
        companyName: str(r.name) ?? str(r.companyName) ?? symbol,
        periodEnd,
        submittedAt: nseTimestamp(r.submissionDate) ?? nseTimestamp(r.cgTimeStamp),
        revised: str(r.revisedData)?.toUpperCase() === "Y" || Boolean(str(r.revisionDate)),
        xbrlUrl,
      },
    ];
  });
}

export function parseIntegratedGovernance(json: string): GovernanceFiling[] {
  return parseIntegratedFilings(json)
    .filter((f) => !f.type || f.type === INTEGRATED_GOVERNANCE)
    .map((f) => ({
      id: f.seqId,
      kind: "integrated" as const,
      symbol: f.symbol,
      companyName: f.companyName,
      periodEnd: f.periodEnd,
      submittedAt: f.submittedAt,
      revised: f.revised,
      xbrlUrl: f.xbrlUrl,
    }));
}

const NOT_APPLICABLE = /^(?:not\s+applicable|na|n\.a\.?|nil|-)$/i;

export function directorRole(positions: readonly string[]): DirectorRole {
  const text = positions.join(" | ").toLowerCase();
  if (/\bchair(?:person|man|woman)?\b/.test(text) && !/\bnot\s+a\s+chair/.test(text)) {
    return "chairman";
  }
  if (/\b(?:md|managing\s+director)\b/.test(text)) return "md";
  if (/\b(?:ceo|chief\s+executive)\b/.test(text)) return "ceo";
  if (/\b(?:cfo|chief\s+financial)\b/.test(text)) return "cfo";
  if (isIndependent(text)) return "independent_director";
  return "director";
}

function isIndependent(text: string): boolean {
  return /\bindependent\b/.test(text.replace(/\bnon[-\s]*independent\b/g, ""));
}

function birthYear(raw: string | null): number | null {
  const y = raw ? Number(/^(\d{4})/.exec(raw)?.[1] ?? /(\d{4})$/.exec(raw)?.[1]) : Number.NaN;
  return Number.isInteger(y) && y >= 1900 && y <= 2100 ? y : null;
}

export function parseGovernanceXbrl(xml: string): GovernanceReport {
  const contexts = xbrlContexts(xml);
  const directors: GovernanceDirector[] = [];
  for (const ids of contextGroups(contexts, "CompBOD").values()) {
    const fact = (name: string) => factOf(contexts, ids, name);
    const name = fact("NameOftheDirector") ?? fact("NameOfTheDirector");
    if (!name) continue;
    const positions = [
      fact("PositionOfDirectorInBoardOne"),
      fact("PositionOfDirectorInBoardTwo"),
      fact("PositionOfDirectorInBoardThree"),
    ].filter((p): p is string => !!p && !NOT_APPLICABLE.test(p));
    const text = positions.join(" | ").toLowerCase();
    const ceasedKey = ids
      .flatMap((id) => [...(contexts.get(id)?.keys() ?? [])])
      .find((k) => /Cessation/i.test(k) && /Date/i.test(k));
    const ceasedOn = ceasedKey ? isoDay(fact(ceasedKey)) : null;
    const statusText = fact("CurrentStatusDirector") ?? "";
    const din = (fact("DirectorIdentificationNumberOfDirector") ?? "").replace(/\D/g, "");
    directors.push({
      din: /^\d{1,8}$/.test(din) && !/^0+$/.test(din) ? din.padStart(8, "0") : null,
      name,
      title: fact("Title"),
      category: positions.length ? positions.join(", ") : null,
      role: directorRole(positions),
      independent: isIndependent(text),
      executive: /\bexecutive\b/.test(text.replace(/\bnon[-\s]*executive\b/g, "")),
      promoterRelated: /\bpromoter/.test(text),
      birthYear: birthYear(fact("DateOfBirth")),
      status: ceasedOn || (statusText && !/^active$/i.test(statusText)) ? "past" : "current",
      appointedOn: isoDay(fact("DateOfAppointmentOfDirector")),
      reappointedOn: isoDay(fact("DateOfReappointmentOfDirector")),
      ceasedOn,
    });
  }
  return {
    symbol: headerFact(contexts, "Symbol") ?? headerFact(contexts, "NSESymbol"),
    isin: headerFact(contexts, "ISIN"),
    companyName: headerFact(contexts, "NameOfTheCompany"),
    periodEnd:
      isoDay(headerFact(contexts, "DateOfEndOfReportingPeriod")) ??
      isoDay(headerFact(contexts, "DateOfReport")),
    directors,
  };
}

export function directorKey(d: Pick<GovernanceDirector, "din" | "name">): string {
  return d.din ?? `name:${d.name.toLowerCase().replace(/\s+/g, " ").trim()}`;
}

export function governanceSnapshot(
  filing: GovernanceFiling,
  report: GovernanceReport,
): GovernanceSnapshot {
  const head = JSON.stringify({
    source: "nse_governance",
    parserVersion: NSE_GOVERNANCE_PARSER_VERSION,
    filing: {
      id: filing.id,
      kind: filing.kind,
      periodEnd: report.periodEnd ?? filing.periodEnd,
      submittedAt: filing.submittedAt?.toISOString() ?? null,
      revised: filing.revised,
      url: filing.xbrlUrl,
    },
    company: {
      symbol: report.symbol ?? filing.symbol,
      isin: report.isin,
      name: report.companyName ?? filing.companyName,
    },
  });
  const spans = new Map<string, { start: number; end: number }>();
  let content = `${head.slice(0, -1)},"directors":[\n`;
  const sorted = [...report.directors].sort((a, b) => directorKey(a).localeCompare(directorKey(b)));
  sorted.forEach((d, i) => {
    const line = JSON.stringify({
      din: d.din,
      name: d.name,
      title: d.title,
      category: d.category,
      role: d.role,
      status: d.status,
      appointedOn: d.appointedOn,
      reappointedOn: d.reappointedOn,
      ceasedOn: d.ceasedOn,
      birthYear: d.birthYear,
    });
    spans.set(directorKey(d), { start: content.length, end: content.length + line.length });
    content += line + (i < sorted.length - 1 ? ",\n" : "\n");
  });
  content += "]}";
  return { content, spans };
}

export class NseGovernanceSource {
  private readonly req: NseRequest;

  constructor(http: HttpClient, baseUrl: string) {
    this.req = { http, baseUrl, referer: "/companies-listing/corporate-integrated-filing" };
  }

  async filings(symbol: string, signal?: AbortSignal): Promise<GovernanceFiling[]> {
    const integrated = this.integrated(symbol, signal);
    const legacy = this.legacy(symbol, signal);
    const [a, b] = await Promise.allSettled([integrated, legacy]);
    if (a.status === "rejected" && b.status === "rejected") throw a.reason;
    return latestFirst([
      ...(a.status === "fulfilled" ? a.value : []),
      ...(b.status === "fulfilled" ? b.value : []),
    ]);
  }

  async report(filing: GovernanceFiling, signal?: AbortSignal): Promise<GovernanceReport> {
    const xml = await nseGet(this.req, filing.xbrlUrl, signal, "application/xml, text/xml, */*");
    return parseGovernanceXbrl(xml);
  }

  private async integrated(symbol: string, signal?: AbortSignal) {
    const url = integratedFilingsUrl(this.req.baseUrl, symbol, INTEGRATED_GOVERNANCE);
    return parseIntegratedGovernance(await nseGet(this.req, url, signal));
  }

  private async legacy(symbol: string, signal?: AbortSignal) {
    const url = `${this.req.baseUrl}/api/corporate-governance-master?index=equities&symbol=${encodeURIComponent(symbol)}`;
    return parseGovernanceMaster(
      await nseGet(
        { ...this.req, referer: "/companies-listing/corporate-filings-governance" },
        url,
        signal,
      ),
    );
  }
}
