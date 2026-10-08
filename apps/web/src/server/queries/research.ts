import {
  analystRatings,
  and,
  asc,
  companyFacts,
  consensusHistory,
  desc,
  earningsEstimates,
  earningsSurprises,
  eq,
  gte,
  type holder,
  priceTargets,
  shareholding,
  sql,
} from "@ma/db";
import type { EstimateMetric, MoneycontrolFacts } from "@ma/ingest";
import type { AppContext } from "../context";
import { findCompany } from "./core";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

type Holder = (typeof holder.enumValues)[number];

export interface ShareholdingQuarter {
  quarterEnd: string;
  promoter: number | null;
  fii: number | null;
  dii: number | null;
  public: number | null;
  others: number | null;
  promoterPledgePct: number | null;
}

export interface AnalystRatingView {
  asOf: string;
  buyPct: number | null;
  outperformPct: number | null;
  holdPct: number | null;
  underperformPct: number | null;
  sellPct: number | null;
  analystCount: number | null;
  finalRating: string | null;
}

export interface ConsensusMonthView {
  month: string;
  buy: number | null;
  outperform: number | null;
  hold: number | null;
  underperform: number | null;
  sell: number | null;
}

export interface EstimateView {
  metric: EstimateMetric;
  fiscalYearEnd: string;
  asOf: string;
  low: number | null;
  avg: number | null;
  high: number | null;
  actual: number | null;
}

export interface PriceTargetView {
  asOf: string;
  low: number | null;
  mean: number | null;
  high: number | null;
}

export interface SurpriseView {
  actual: number | null;
  estimate: number | null;
  surprisePct: number | null;
  outcome: string;
}

export interface SurpriseQuarter {
  quarterEnd: string;
  eps: SurpriseView | null;
  revenue: SurpriseView | null;
  netProfit: SurpriseView | null;
}

export interface CompanyResearch {
  symbol: string;
  shareholding: ShareholdingQuarter[];
  ratings: AnalystRatingView | null;
  consensusHistory: ConsensusMonthView[];
  estimates: EstimateView[];
  priceTargets: PriceTargetView | null;
  surprises: SurpriseQuarter[];
  facts: (MoneycontrolFacts & { fetchedAt: string }) | null;
}

const toNum = (v: string | null): number | null => (v === null ? null : Number(v));

export async function companyResearch(ctx: AppContext, symbol: string): Promise<CompanyResearch> {
  const company = await findCompany(ctx, symbol);
  const sym = company.nseSymbol ?? symbol.toUpperCase();
  const research = await ctx.api.getOrLoad(
    `research:${sym}`,
    () => loadResearch(ctx, company.id, sym),
    { ttlMs: 10 * MINUTE, staleMs: HOUR },
  );
  return research ?? emptyResearch(sym);
}

async function loadResearch(
  ctx: AppContext,
  companyId: number,
  symbol: string,
): Promise<CompanyResearch> {
  const today = new Date().toISOString().slice(0, 10);
  const [holdings, rating, consensus, latestEstimateDay, target, surprises, facts] =
    await Promise.all([
      ctx.db
        .select()
        .from(shareholding)
        .where(
          and(
            eq(shareholding.companyId, companyId),
            sql`${shareholding.quarterEnd} in (select distinct quarter_end from shareholding where company_id = ${companyId} order by quarter_end desc limit 8)`,
          ),
        )
        .orderBy(asc(shareholding.quarterEnd)),
      ctx.db.query.analystRatings.findFirst({
        where: eq(analystRatings.companyId, companyId),
        orderBy: desc(analystRatings.asOf),
      }),
      ctx.db
        .select()
        .from(consensusHistory)
        .where(eq(consensusHistory.companyId, companyId))
        .orderBy(desc(consensusHistory.month))
        .limit(6),
      ctx.db
        .select({ asOf: sql<string | null>`max(${earningsEstimates.asOf})` })
        .from(earningsEstimates)
        .where(eq(earningsEstimates.companyId, companyId)),
      ctx.db.query.priceTargets.findFirst({
        where: eq(priceTargets.companyId, companyId),
        orderBy: desc(priceTargets.asOf),
      }),
      ctx.db
        .select()
        .from(earningsSurprises)
        .where(
          and(
            eq(earningsSurprises.companyId, companyId),
            sql`${earningsSurprises.quarterEnd} in (select distinct quarter_end from earnings_surprises where company_id = ${companyId} order by quarter_end desc limit 4)`,
          ),
        )
        .orderBy(desc(earningsSurprises.quarterEnd)),
      ctx.db.query.companyFacts.findFirst({
        where: and(eq(companyFacts.companyId, companyId), eq(companyFacts.source, "moneycontrol")),
      }),
    ]);

  const estimateAsOf = latestEstimateDay[0]?.asOf ?? null;
  const estimateRows = estimateAsOf
    ? await ctx.db
        .select()
        .from(earningsEstimates)
        .where(
          and(
            eq(earningsEstimates.companyId, companyId),
            eq(earningsEstimates.asOf, estimateAsOf),
            eq(earningsEstimates.consolidated, true),
            gte(earningsEstimates.fiscalYearEnd, today),
          ),
        )
        .orderBy(asc(earningsEstimates.fiscalYearEnd), asc(earningsEstimates.metric))
    : [];
  const nextYears = [...new Set(estimateRows.map((r) => r.fiscalYearEnd))].slice(0, 2);

  return {
    symbol,
    shareholding: pivotShareholding(holdings),
    ratings: rating
      ? {
          asOf: rating.asOf,
          buyPct: rating.buyPct,
          outperformPct: rating.outperformPct,
          holdPct: rating.holdPct,
          underperformPct: rating.underperformPct,
          sellPct: rating.sellPct,
          analystCount: rating.analystCount,
          finalRating: rating.finalRating,
        }
      : null,
    consensusHistory: consensus
      .map((c) => ({
        month: c.month,
        buy: c.buy,
        outperform: c.outperform,
        hold: c.hold,
        underperform: c.underperform,
        sell: c.sell,
      }))
      .reverse(),
    estimates: estimateRows
      .filter((r) => nextYears.includes(r.fiscalYearEnd))
      .map((r) => ({
        metric: r.metric,
        fiscalYearEnd: r.fiscalYearEnd,
        asOf: r.asOf,
        low: toNum(r.low),
        avg: toNum(r.avg),
        high: toNum(r.high),
        actual: toNum(r.actual),
      })),
    priceTargets: target
      ? { asOf: target.asOf, low: target.low, mean: target.mean, high: target.high }
      : null,
    surprises: pivotSurprises(surprises),
    facts: facts
      ? {
          ...(facts.facts as unknown as MoneycontrolFacts),
          fetchedAt: facts.fetchedAt.toISOString(),
        }
      : null,
  };
}

function pivotShareholding(rows: Array<typeof shareholding.$inferSelect>): ShareholdingQuarter[] {
  const byQuarter = new Map<string, ShareholdingQuarter>();
  for (const r of rows) {
    let q = byQuarter.get(r.quarterEnd);
    if (!q) {
      q = {
        quarterEnd: r.quarterEnd,
        promoter: null,
        fii: null,
        dii: null,
        public: null,
        others: null,
        promoterPledgePct: null,
      };
      byQuarter.set(r.quarterEnd, q);
    }
    q[r.holder as Holder] = r.pct;
    if (r.holder === "promoter") q.promoterPledgePct = r.pledgePct;
  }
  return [...byQuarter.values()];
}

function pivotSurprises(rows: Array<typeof earningsSurprises.$inferSelect>): SurpriseQuarter[] {
  const key = { eps: "eps", revenue: "revenue", net_profit: "netProfit" } as const;
  const byQuarter = new Map<string, SurpriseQuarter>();
  for (const r of rows) {
    let q = byQuarter.get(r.quarterEnd);
    if (!q) {
      q = { quarterEnd: r.quarterEnd, eps: null, revenue: null, netProfit: null };
      byQuarter.set(r.quarterEnd, q);
    }
    q[key[r.metric]] = {
      actual: toNum(r.actual),
      estimate: toNum(r.estimate),
      surprisePct: r.surprisePct,
      outcome: r.outcome,
    };
  }
  return [...byQuarter.values()];
}

function emptyResearch(symbol: string): CompanyResearch {
  return {
    symbol,
    shareholding: [],
    ratings: null,
    consensusHistory: [],
    estimates: [],
    priceTargets: null,
    surprises: [],
    facts: null,
  };
}
