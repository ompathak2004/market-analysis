import { throwIfAborted } from "@ma/core";
import { companies, eq, fencedTransaction, fundamentals, sql } from "@ma/db";
import type { IngestContext } from "../context.js";
import {
  parseScreenerCompany,
  SCREENER_PARSER_VERSION,
  type ScreenerCompany,
  type ScreenerPeriod,
  screenerUrl,
} from "../sources/screener.js";

const DAY_MS = 86_400_000;

export interface FundamentalsSyncResult {
  periods: number;
  changed: boolean;
  annualReports: ScreenerCompany["annualReports"];
  concalls: ScreenerCompany["concalls"];
}

export async function syncFundamentals(
  ctx: IngestContext,
  companyId: number,
  signal?: AbortSignal,
): Promise<FundamentalsSyncResult | null> {
  const company = await ctx.db.query.companies.findFirst({ where: eq(companies.id, companyId) });
  if (!company?.screenerSlug) return null;

  const { doc, text, changed } = await ctx.docs.fetch(screenerUrl(company.screenerSlug), {
    source: "screener",
    companyId,
    maxAgeMs: DAY_MS,
    ...(signal ? { signal } : {}),
  });
  const parsed = parseScreenerCompany(text);
  const upToDate =
    !changed && doc.status === "parsed" && doc.parserVersion === SCREENER_PARSER_VERSION;
  if (upToDate) {
    return {
      periods: 0,
      changed: false,
      annualReports: parsed.annualReports,
      concalls: parsed.concalls,
    };
  }

  const periods = [...parsed.annual, ...parsed.quarterly];
  throwIfAborted(signal);
  await fencedTransaction(
    ctx.db,
    async (tx) => {
      if (periods.length) {
        await tx
          .insert(fundamentals)
          .values(periods.map((p) => toRow(companyId, doc.id, p)))
          .onConflictDoUpdate({
            target: [fundamentals.companyId, fundamentals.periodEnd, fundamentals.periodType],
            set: {
              revenue: sql`excluded.revenue`,
              cogs: sql`excluded.cogs`,
              operatingProfit: sql`excluded.operating_profit`,
              interestExpense: sql`excluded.interest_expense`,
              pretaxIncome: sql`excluded.pretax_income`,
              netIncome: sql`excluded.net_income`,
              totalAssets: sql`excluded.total_assets`,
              totalEquity: sql`excluded.total_equity`,
              totalDebt: sql`excluded.total_debt`,
              cashFromOps: sql`excluded.cash_from_ops`,
              sourceDocumentId: sql`excluded.source_document_id`,
              updatedAt: sql`now()`,
            },
          });
      }

      await tx
        .update(companies)
        .set({
          sector: parsed.sectorPath[0] ?? company.sector,
          industry: parsed.sectorPath.at(-1) ?? company.industry,
          marketCapCr: parsed.marketCapCr?.toString() ?? company.marketCapCr,
          updatedAt: new Date(),
        })
        .where(eq(companies.id, companyId));
      await ctx.docs.markParsed(doc.id, SCREENER_PARSER_VERSION, "parsed", tx);
    },
    signal,
  );

  return {
    periods: periods.length,
    changed: true,
    annualReports: parsed.annualReports,
    concalls: parsed.concalls,
  };
}

const num = (v: number | null | undefined): string | null => (v == null ? null : v.toString());

function toRow(companyId: number, documentId: number, p: ScreenerPeriod) {
  const v = p.values;
  return {
    companyId,
    periodEnd: p.periodEnd,
    periodType: p.periodType,
    revenue: num(v.revenue),
    cogs: num(v.cogs),
    operatingProfit: num(v.operatingProfit),
    interestExpense: num(v.interestExpense),
    pretaxIncome: num(v.pretaxIncome),
    netIncome: num(v.netIncome),
    totalAssets: num(v.totalAssets),
    totalEquity: num(v.totalEquity),
    totalDebt: num(v.totalDebt),
    cashFromOps: num(v.cashFromOps),
    sourceDocumentId: documentId,
  };
}
