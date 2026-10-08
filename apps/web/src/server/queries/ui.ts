import {
  aircraftFlights,
  altdataCoverage,
  altdataEvents,
  analystCalls,
  analystRatings,
  and,
  announcements,
  chokepointTransits,
  companies,
  consensusHistory,
  corporateAircraft,
  corporateAircraftCompanies,
  desc,
  earningsEstimates,
  earningsSurprises,
  eq,
  facilities,
  facilityCompanies,
  gte,
  inArray,
  insights,
  isNull,
  priceTargets,
  shareholding,
  signals,
  sql,
  vesselCalls,
  vesselFleet,
  vesselPositions,
  vessels,
} from "@ma/db";
import type {
  AltdataSignalInputs,
  BrokerDigest,
  BrokerThesis,
  CompanyBrief,
  Evidence,
  MarketBrief,
  RuleInsight,
  VerdictLabel,
} from "@ma/intel";
import { verdictLabelFor } from "@ma/intel";
import type { AppContext } from "../context";
import { analystView, companyOverview, financials, findCompany, priceHistory } from "./core";
import type {
  AltdataActivityItem,
  BrokerCall,
  BrokerDigestView,
  CompanyBriefView,
  CompanyLogistics,
  CompanyResearch,
  CompanyTravel,
  FeedItem,
  FilingItem,
  InsightMeta,
  KeyStats,
  LatestBrokerCall,
  MarketBriefView,
  Peer,
  QuoteView,
  RangeStats,
  ShareholdingQuarter,
  SignalRow,
  WeeklyCount,
} from "./types";

const MINUTE = 60_000;
const DAY = 86_400_000;

function iso(v: Date | string | null | undefined): string | null {
  if (v == null) return null;
  return typeof v === "string" ? new Date(v).toISOString() : v.toISOString();
}

function n(v: number | string | null | undefined): number | null {
  if (v == null || v === "") return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * DAY);
}

type InsightRow = typeof insights.$inferSelect;

function metaOf(row: InsightRow): InsightMeta {
  return {
    model: row.model,
    modelVersion: row.modelVersion,
    generatedAt: iso(row.generatedAt) ?? new Date().toISOString(),
    inputHash: row.inputHash,
    confidence: row.confidence ?? null,
  };
}

function evidenceOf(inputs: Record<string, unknown>): Evidence[] {
  const list = inputs.evidence;
  if (!Array.isArray(list)) return [];
  return list.filter(
    (e): e is Evidence =>
      typeof e === "object" && e != null && typeof (e as Evidence).id === "string",
  );
}

async function currentInsights(
  ctx: AppContext,
  kind: string,
  companyId: number | null,
  limit = 1,
): Promise<InsightRow[]> {
  return ctx.db
    .select()
    .from(insights)
    .where(
      and(
        eq(insights.kind, kind),
        companyId == null ? isNull(insights.companyId) : eq(insights.companyId, companyId),
      ),
    )
    .orderBy(desc(insights.generatedAt))
    .limit(limit);
}

export async function companyBrief(
  ctx: AppContext,
  symbol: string,
): Promise<CompanyBriefView | null> {
  const company = await findCompany(ctx, symbol);
  return ctx.api.getOrLoad(
    `ui:brief:${company.id}`,
    async () => {
      const rows = await currentInsights(ctx, "company_brief", company.id, 2);
      const [cur, prev] = rows;
      if (!cur) return null;
      const brief = cur.output as unknown as CompanyBrief;
      const prevBrief = prev ? (prev.output as unknown as CompanyBrief) : null;
      return {
        brief,
        meta: metaOf(cur),
        evidence: evidenceOf(cur.inputs),
        previous:
          prev && prevBrief
            ? {
                score: prevBrief.verdict.score,
                label: prevBrief.verdict.label,
                generatedAt: iso(prev.generatedAt) ?? "",
              }
            : null,
      };
    },
    { ttlMs: 5 * MINUTE, staleMs: 30 * MINUTE },
  );
}

export async function brokerDigest(
  ctx: AppContext,
  symbol: string,
): Promise<BrokerDigestView | null> {
  const company = await findCompany(ctx, symbol);
  return ctx.api.getOrLoad(
    `ui:digest:${company.id}`,
    async () => {
      const [row] = await currentInsights(ctx, "broker_digest", company.id);
      return row ? { digest: row.output as unknown as BrokerDigest, meta: metaOf(row) } : null;
    },
    { ttlMs: 5 * MINUTE, staleMs: 30 * MINUTE },
  );
}

export async function marketBrief(ctx: AppContext): Promise<MarketBriefView | null> {
  return ctx.api.getOrLoad(
    "ui:market-brief",
    async () => {
      const [row] = await currentInsights(ctx, "market_brief", null);
      if (!row) return null;
      const evidence = evidenceOf(row.inputs);
      return {
        brief: row.output as unknown as MarketBrief,
        meta: metaOf(row),
        evidence,
        inputCount: evidence.length || Object.keys(row.inputs).length,
      };
    },
    { ttlMs: 5 * MINUTE, staleMs: 30 * MINUTE },
  );
}

export async function intelligenceFeed(ctx: AppContext, limit = 30): Promise<FeedItem[]> {
  const rows = await ctx.api.getOrLoad(
    `ui:feed:${limit}`,
    async () => {
      const rows = await ctx.db
        .selectDistinctOn([insights.companyId], {
          companyId: insights.companyId,
          output: insights.output,
          generatedAt: insights.generatedAt,
          symbol: companies.nseSymbol,
          name: companies.name,
          sector: companies.sector,
        })
        .from(insights)
        .innerJoin(companies, eq(companies.id, insights.companyId))
        .where(eq(insights.kind, "company_brief"))
        .orderBy(insights.companyId, desc(insights.generatedAt));
      return rows
        .map((r) => {
          const b = r.output as unknown as CompanyBrief;
          return {
            symbol: r.symbol ?? "",
            name: r.name,
            sector: r.sector ?? null,
            score: b.verdict?.score ?? 50,
            label: b.verdict?.label ?? verdictLabelFor(b.verdict?.score ?? 50),
            confidence: b.verdict?.confidence ?? 0,
            oneLiner: b.verdict?.oneLiner ?? "",
            whatChanged: b.whatChanged?.[0] ?? null,
            generatedAt: iso(r.generatedAt) ?? "",
          };
        })
        .sort((a, b) => b.generatedAt.localeCompare(a.generatedAt))
        .slice(0, limit);
    },
    { ttlMs: 5 * MINUTE, staleMs: 30 * MINUTE },
  );
  return rows ?? [];
}

export async function recentFilings(ctx: AppContext, limit = 40): Promise<FilingItem[]> {
  const rows = await ctx.api.getOrLoad(
    `ui:filings:${limit}`,
    async () => {
      const rows = await ctx.db
        .select({
          id: announcements.id,
          symbol: companies.nseSymbol,
          name: companies.name,
          publishedAt: announcements.publishedAt,
          subject: announcements.subject,
          category: announcements.category,
          materiality: announcements.materiality,
          soWhat: announcements.soWhat,
          attachmentUrl: announcements.attachmentUrl,
        })
        .from(announcements)
        .innerJoin(companies, eq(companies.id, announcements.companyId))
        .where(gte(announcements.publishedAt, daysAgo(30)))
        .orderBy(desc(announcements.publishedAt))
        .limit(limit);
      return rows.map((r) => ({
        ...r,
        symbol: r.symbol ?? "",
        publishedAt: iso(r.publishedAt) ?? "",
        category: r.category ?? null,
        materiality: r.materiality ?? null,
        soWhat: r.soWhat ?? null,
        attachmentUrl: r.attachmentUrl ?? null,
      }));
    },
    { ttlMs: 5 * MINUTE, staleMs: 30 * MINUTE },
  );
  return rows ?? [];
}

function thesisOf(v: unknown): BrokerThesis | null {
  if (!v || typeof v !== "object") return null;
  const t = v as BrokerThesis;
  return Array.isArray(t.keyPoints) ? t : null;
}

type CallRow = typeof analystCalls.$inferSelect;

function callOf(c: CallRow): BrokerCall {
  return {
    id: c.id,
    broker: c.broker,
    publishedAt: c.publishedAt,
    action: c.action,
    rating: c.rating,
    priorRating: c.priorRating ?? null,
    targetPrice: c.targetPrice ?? null,
    priorTargetPrice: c.priorTargetPrice ?? null,
    priceAtCall: c.priceAtCall ?? null,
    reportUrl: c.reportUrl ?? null,
    title: c.title ?? null,
    summary: c.summary ?? null,
    thesis: thesisOf(c.thesis),
  };
}

export async function latestBrokerCalls(ctx: AppContext, limit = 40): Promise<LatestBrokerCall[]> {
  const rows = await ctx.api.getOrLoad(
    `ui:calls:${limit}`,
    async () => {
      const rows = await ctx.db
        .select({ call: analystCalls, symbol: companies.nseSymbol, name: companies.name })
        .from(analystCalls)
        .innerJoin(companies, eq(companies.id, analystCalls.companyId))
        .orderBy(desc(analystCalls.publishedAt), desc(analystCalls.id))
        .limit(limit);
      return rows.map((r) => {
        const c = callOf(r.call);
        const base = c.priceAtCall;
        return {
          ...c,
          symbol: r.symbol ?? "",
          name: r.name,
          upsidePct: c.targetPrice != null && base ? ((c.targetPrice - base) / base) * 100 : null,
        };
      });
    },
    { ttlMs: 5 * MINUTE, staleMs: 30 * MINUTE },
  );
  return rows ?? [];
}

export async function companyResearch(ctx: AppContext, symbol: string): Promise<CompanyResearch> {
  const company = await findCompany(ctx, symbol);
  const view = await analystView(ctx, symbol, 12).catch(() => null);
  const research = await ctx.api.getOrLoad(
    `ui:research:${company.id}`,
    async () => {
      const id = company.id;
      const [holding, ratings, consensus, estimates, targets, surprises] = await Promise.all([
        ctx.db
          .select()
          .from(shareholding)
          .where(eq(shareholding.companyId, id))
          .orderBy(desc(shareholding.quarterEnd))
          .limit(40),
        ctx.db
          .select()
          .from(analystRatings)
          .where(eq(analystRatings.companyId, id))
          .orderBy(desc(analystRatings.asOf))
          .limit(1),
        ctx.db
          .select()
          .from(consensusHistory)
          .where(eq(consensusHistory.companyId, id))
          .orderBy(desc(consensusHistory.month))
          .limit(12),
        ctx.db
          .selectDistinctOn([earningsEstimates.metric, earningsEstimates.fiscalYearEnd])
          .from(earningsEstimates)
          .where(and(eq(earningsEstimates.companyId, id), eq(earningsEstimates.consolidated, true)))
          .orderBy(
            earningsEstimates.metric,
            earningsEstimates.fiscalYearEnd,
            desc(earningsEstimates.asOf),
          ),
        ctx.db
          .select()
          .from(priceTargets)
          .where(eq(priceTargets.companyId, id))
          .orderBy(desc(priceTargets.asOf))
          .limit(1),
        ctx.db
          .select()
          .from(earningsSurprises)
          .where(eq(earningsSurprises.companyId, id))
          .orderBy(desc(earningsSurprises.quarterEnd))
          .limit(12),
      ]);
      const byQuarter = new Map<string, ShareholdingQuarter>();
      for (const h of holding) {
        const q = byQuarter.get(h.quarterEnd) ?? {
          quarterEnd: h.quarterEnd,
          promoter: null,
          fii: null,
          dii: null,
          public: null,
          others: null,
          pledge: null,
        };
        q[h.holder] = h.pct;
        if (h.holder === "promoter") q.pledge = h.pledgePct ?? null;
        byQuarter.set(h.quarterEnd, q);
      }
      const r = ratings[0];
      const t = targets[0];
      return {
        shareholding: [...byQuarter.values()].slice(0, 8),
        ratings: r
          ? {
              asOf: r.asOf,
              buyPct: r.buyPct ?? null,
              outperformPct: r.outperformPct ?? null,
              holdPct: r.holdPct ?? null,
              underperformPct: r.underperformPct ?? null,
              sellPct: r.sellPct ?? null,
              analystCount: r.analystCount ?? null,
              finalRating: r.finalRating ?? null,
            }
          : null,
        consensus: consensus
          .map((c) => ({
            month: c.month,
            buy: c.buy ?? 0,
            outperform: c.outperform ?? 0,
            hold: c.hold ?? 0,
            underperform: c.underperform ?? 0,
            sell: c.sell ?? 0,
          }))
          .reverse(),
        estimates: estimates.map((e) => ({
          metric: e.metric,
          fiscalYearEnd: e.fiscalYearEnd,
          asOf: e.asOf,
          low: n(e.low),
          high: n(e.high),
          avg: n(e.avg),
          actual: n(e.actual),
        })),
        target: t
          ? { asOf: t.asOf, low: t.low ?? null, mean: t.mean ?? null, high: t.high ?? null }
          : null,
        surprises: surprises.map((s) => ({
          metric: s.metric,
          quarterEnd: s.quarterEnd,
          actual: n(s.actual),
          estimate: n(s.estimate),
          surprisePct: s.surprisePct ?? null,
          outcome: s.outcome,
        })),
        calls: (view?.calls ?? []).map((c) => callOf(c as CallRow)),
        price: view?.summary.price ?? null,
      };
    },
    { ttlMs: 5 * MINUTE, staleMs: 30 * MINUTE },
  );
  return research ?? EMPTY_RESEARCH;
}

const EMPTY_RESEARCH: CompanyResearch = {
  shareholding: [],
  ratings: null,
  consensus: [],
  estimates: [],
  target: null,
  surprises: [],
  calls: [],
  price: null,
};

const NO_FIN = { annual: [], quarterly: [] };

async function fundamentalsOf(ctx: AppContext, symbol: string) {
  return (await financials(ctx, symbol)) ?? NO_FIN;
}

async function barsOf(ctx: AppContext, symbol: string, range: "1mo" | "max") {
  return (await priceHistory(ctx, symbol, range)) ?? [];
}

type FundRow = NonNullable<Awaited<ReturnType<typeof financials>>>["annual"][number];

function ttm(quarters: FundRow[], key: keyof FundRow): number | null {
  const last = quarters.slice(-4);
  if (last.length < 4) return null;
  const vals = last.map((q) => n(q[key] as string | null));
  if (vals.some((v) => v == null)) return null;
  return (vals as number[]).reduce((s, v) => s + v, 0);
}

function growth(cur: number | null, prev: number | null): number | null {
  if (cur == null || prev == null || prev === 0) return null;
  return ((cur - prev) / Math.abs(prev)) * 100;
}

function ratio(a: number | null, b: number | null, scale = 1): number | null {
  if (a == null || b == null || b === 0) return null;
  return (a / b) * scale;
}

export async function keyStats(ctx: AppContext, symbol: string): Promise<KeyStats> {
  const [overview, fin] = await Promise.all([
    companyOverview(ctx, symbol),
    fundamentalsOf(ctx, symbol),
  ]);
  const { company, quote } = overview;
  const annual = fin.annual;
  const lastA = annual.at(-1) ?? null;
  const prevA = annual.at(-2) ?? null;
  const mcap = n(company.marketCapCr);
  const netTtm = ttm(fin.quarterly, "netIncome") ?? n(lastA?.netIncome);
  const revTtm = ttm(fin.quarterly, "revenue") ?? n(lastA?.revenue);
  const equity = n(lastA?.totalEquity);
  return {
    symbol: company.nseSymbol ?? symbol,
    name: company.name,
    sector: company.sector ?? null,
    industry: company.industry ?? null,
    isin: company.isin ?? null,
    marketCapCr: mcap,
    price: quote?.price ?? null,
    changePct: quote?.changePct ?? null,
    peTtm: netTtm && netTtm > 0 ? ratio(mcap, netTtm) : null,
    pb: equity && equity > 0 ? ratio(mcap, equity) : null,
    roePct: ratio(n(lastA?.netIncome), equity, 100),
    opmPct: ratio(n(lastA?.operatingProfit), n(lastA?.revenue), 100),
    npmPct: ratio(n(lastA?.netIncome), n(lastA?.revenue), 100),
    debtToEquity: ratio(n(lastA?.totalDebt), equity),
    interestCover: ratio(n(lastA?.operatingProfit), n(lastA?.interestExpense)),
    revenueGrowthPct: growth(n(lastA?.revenue), n(prevA?.revenue)),
    profitGrowthPct: growth(n(lastA?.netIncome), n(prevA?.netIncome)),
    revenueTtmCr: revTtm,
    netIncomeTtmCr: netTtm,
    latestAnnual: lastA?.periodEnd ?? null,
    latestQuarter: fin.quarterly.at(-1)?.periodEnd ?? null,
  };
}

export async function peers(ctx: AppContext, symbol: string, limit = 12): Promise<Peer[]> {
  const company = await findCompany(ctx, symbol);
  if (!company.sector) return [];
  const rows = await ctx.api.getOrLoad(
    `ui:peers:${company.id}:${limit}`,
    async () => {
      const rows = await ctx.db.execute<{
        symbol: string;
        name: string;
        industry: string | null;
        market_cap_cr: string | null;
        close: number | null;
        prev: number | null;
        distress: number | null;
        id: number;
      }>(sql`
        select c.id, c.nse_symbol symbol, c.name, c.industry, c.market_cap_cr,
          p.close, p.prev, s.value distress
        from companies c
        left join lateral (
          select close, lag(close) over (order by date) prev
          from (select date, close from prices_daily where company_id = c.id order by date desc limit 2) t
          order by date desc limit 1
        ) p on true
        left join lateral (
          select value from signals where company_id = c.id and kind = 'distress_score'
          order by as_of desc limit 1
        ) s on true
        where c.sector = ${company.sector} and c.nse_symbol is not null
        order by c.market_cap_cr desc nulls last
        limit ${limit}`);
      return [...rows].map((r) => ({
        symbol: r.symbol,
        name: r.name,
        industry: r.industry ?? null,
        marketCapCr: n(r.market_cap_cr),
        close: n(r.close),
        changePct: r.close != null && r.prev ? ((r.close - r.prev) / r.prev) * 100 : null,
        distress: n(r.distress),
        self: r.id === company.id,
      }));
    },
    { ttlMs: 10 * MINUTE, staleMs: 60 * MINUTE },
  );
  return rows ?? [];
}

function stdev(values: number[]): number | null {
  if (values.length < 2) return null;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const v = values.reduce((s, x) => s + (x - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(v);
}

export async function rangeStats(ctx: AppContext, symbol: string): Promise<RangeStats> {
  const bars = await barsOf(ctx, symbol, "max");
  const closes = bars.map((b) => Number(b.close));
  const last = closes.at(-1) ?? null;
  const lastDate = bars.at(-1)?.date ?? null;
  const year = bars.slice(-252);
  const high52 = year.length ? Math.max(...year.map((b) => Number(b.high ?? b.close))) : null;
  const low52 = year.length ? Math.min(...year.map((b) => Number(b.low ?? b.close))) : null;
  const ret = (days: number) => {
    const base = closes.at(-1 - days);
    return last != null && base ? ((last - base) / base) * 100 : null;
  };
  const daily = closes
    .slice(-253)
    .map((c, i, arr) => (i ? Math.log(c / (arr[i - 1] as number)) : 0));
  const sd = stdev(daily.slice(1));
  const avg = (k: number) =>
    closes.length >= k ? closes.slice(-k).reduce((s, v) => s + v, 0) / k : null;
  const vols = bars.slice(-20).map((b) => Number(b.volume ?? 0));
  return {
    last,
    lastDate,
    high52,
    low52,
    fromHighPct: last != null && high52 ? ((last - high52) / high52) * 100 : null,
    fromLowPct: last != null && low52 ? ((last - low52) / low52) * 100 : null,
    returns: [
      { label: "1W", pct: ret(5) },
      { label: "1M", pct: ret(21) },
      { label: "3M", pct: ret(63) },
      { label: "6M", pct: ret(126) },
      { label: "1Y", pct: ret(252) },
      { label: "2Y", pct: ret(504) },
    ],
    volatilityPct: sd != null ? sd * Math.sqrt(252) * 100 : null,
    avgVolume20: vols.length ? vols.reduce((s, v) => s + v, 0) / vols.length : null,
    sma50: avg(50),
    sma200: avg(200),
    bars: bars.length,
  };
}

function istDay(d: Date | string): string {
  const t = typeof d === "string" ? new Date(d) : d;
  return new Date(t.getTime() + 5.5 * 3600_000).toISOString().slice(0, 10);
}

export async function quoteView(ctx: AppContext, symbol: string): Promise<QuoteView> {
  const [overview, bars, stats] = await Promise.all([
    companyOverview(ctx, symbol),
    barsOf(ctx, symbol, "1mo"),
    keyStats(ctx, symbol),
  ]);
  const range = await rangeStats(ctx, symbol);
  const { company, quote } = overview;
  const lastBar = bars.at(-1);
  const prevBar = bars.at(-2);
  let price: number | null = quote?.price ?? null;
  let prev: number | null = null;
  let dayLow: number | null = null;
  let dayHigh: number | null = null;
  if (quote && lastBar) {
    const sameDay = istDay(quote.marketTime) === lastBar.date;
    prev = sameDay ? Number(prevBar?.close ?? null) || null : Number(lastBar.close);
    if (sameDay) {
      dayLow = n(lastBar.low);
      dayHigh = n(lastBar.high);
    }
  } else if (!quote && lastBar) {
    price = Number(lastBar.close);
    prev = prevBar ? Number(prevBar.close) : null;
    dayLow = n(lastBar.low);
    dayHigh = n(lastBar.high);
  } else if (quote) {
    prev = quote.previousClose ?? null;
  }
  const change = price != null && prev ? price - prev : (quote?.change ?? null);
  const changePct =
    price != null && prev ? ((price - prev) / prev) * 100 : (quote?.changePct ?? null);
  if (price != null) {
    dayLow = dayLow == null ? price : Math.min(dayLow, price);
    dayHigh = dayHigh == null ? price : Math.max(dayHigh, price);
  }
  return {
    symbol: company.nseSymbol ?? symbol,
    name: company.name,
    sector: company.sector ?? null,
    industry: company.industry ?? null,
    isin: company.isin ?? null,
    marketCapCr: n(company.marketCapCr),
    price,
    change,
    changePct,
    dayLow,
    dayHigh,
    high52: range.high52 != null && price != null ? Math.max(range.high52, price) : range.high52,
    low52: range.low52 != null && price != null ? Math.min(range.low52, price) : range.low52,
    peTtm: stats.peTtm,
    marketState: quote?.marketState ?? null,
    asOf: quote ? iso(quote.marketTime) : lastBar ? `${lastBar.date}T10:00:00.000Z` : null,
    source: quote ? "live" : lastBar ? "close" : "none",
  };
}

export async function ruleInsights(ctx: AppContext, symbol: string): Promise<RuleInsight[]> {
  const company = await findCompany(ctx, symbol);
  const [range, stats, fin, sig, research] = await Promise.all([
    rangeStats(ctx, symbol),
    keyStats(ctx, symbol),
    fundamentalsOf(ctx, symbol),
    ctx.db
      .selectDistinctOn([signals.kind])
      .from(signals)
      .where(eq(signals.companyId, company.id))
      .orderBy(signals.kind, desc(signals.asOf)),
    companyResearch(ctx, symbol),
  ]);
  const out: RuleInsight[] = [];
  const push = (
    id: string,
    group: RuleInsight["group"],
    toneOf: number | null,
    text: string,
    value: number | null,
    evidence: string[] = [],
    flip = false,
  ) => {
    const t =
      toneOf == null || toneOf === 0 ? "neutral" : toneOf > 0 !== flip ? "positive" : "negative";
    out.push({ id, group, tone: t, text, value, evidence });
  };
  const fmt = (v: number, d = 1) => `${v > 0 ? "+" : ""}${v.toFixed(d)}%`;

  const y1 = range.returns.find((r) => r.label === "1Y")?.pct ?? null;
  if (y1 != null) push("price.1y", "price", y1, `Stock ${fmt(y1)} over 1 year`, y1, ["prices"]);
  if (range.fromHighPct != null)
    push(
      "price.52w",
      "price",
      range.fromHighPct > -5 ? 1 : range.fromHighPct < -20 ? -1 : 0,
      `Trading ${Math.abs(range.fromHighPct).toFixed(1)}% below its 52-week high`,
      range.fromHighPct,
      ["prices"],
    );
  if (range.last != null && range.sma200 != null)
    push(
      "price.sma200",
      "price",
      range.last - range.sma200,
      `Price ${range.last >= range.sma200 ? "above" : "below"} the 200-day average (${fmt(((range.last - range.sma200) / range.sma200) * 100)})`,
      range.sma200,
      ["prices"],
    );
  if (range.volatilityPct != null)
    push(
      "price.vol",
      "price",
      range.volatilityPct > 40 ? -1 : 0,
      `Annualised volatility ${range.volatilityPct.toFixed(1)}%`,
      range.volatilityPct,
      ["prices"],
    );

  if (stats.revenueGrowthPct != null)
    push(
      "fin.rev",
      "financials",
      stats.revenueGrowthPct,
      `Revenue ${stats.revenueGrowthPct >= 0 ? "grew" : "fell"} ${Math.abs(stats.revenueGrowthPct).toFixed(1)}% in the latest fiscal year`,
      stats.revenueGrowthPct,
      ["fundamentals"],
    );
  if (stats.profitGrowthPct != null)
    push(
      "fin.np",
      "financials",
      stats.profitGrowthPct,
      `Net profit ${stats.profitGrowthPct >= 0 ? "up" : "down"} ${Math.abs(stats.profitGrowthPct).toFixed(1)}% YoY`,
      stats.profitGrowthPct,
      ["fundamentals"],
    );
  const a = fin.annual;
  const opm = (r: FundRow | undefined) =>
    r ? ratio(n(r.operatingProfit), n(r.revenue), 100) : null;
  const opmNow = opm(a.at(-1));
  const opmPrev = opm(a.at(-2));
  if (opmNow != null && opmPrev != null)
    push(
      "fin.opm",
      "financials",
      opmNow - opmPrev,
      `Operating margin ${opmNow.toFixed(1)}% vs ${opmPrev.toFixed(1)}% a year earlier`,
      opmNow,
      ["fundamentals"],
    );
  if (stats.roePct != null)
    push(
      "fin.roe",
      "financials",
      stats.roePct >= 15 ? 1 : stats.roePct < 8 ? -1 : 0,
      `Return on equity ${stats.roePct.toFixed(1)}%`,
      stats.roePct,
      ["fundamentals"],
    );
  if (stats.debtToEquity != null)
    push(
      "fin.de",
      "financials",
      stats.debtToEquity > 1 ? -1 : stats.debtToEquity < 0.3 ? 1 : 0,
      `Debt to equity ${stats.debtToEquity.toFixed(2)}x`,
      stats.debtToEquity,
      ["fundamentals"],
    );
  const last = a.at(-1);
  const cfo = n(last?.cashFromOps);
  const ni = n(last?.netIncome);
  if (cfo != null && ni != null && ni > 0)
    push(
      "fin.cfo",
      "financials",
      cfo / ni >= 0.9 ? 1 : cfo / ni < 0.6 ? -1 : 0,
      `Operating cash flow covers ${((cfo / ni) * 100).toFixed(0)}% of reported profit`,
      cfo / ni,
      ["fundamentals"],
    );

  for (const s of sig) {
    if (s.kind === "distress_score")
      push(
        "sc.distress",
        "supply_chain",
        s.value > 0.5 ? -1 : s.value < 0.2 ? 1 : 0,
        `Distress score ${s.value.toFixed(3)} (${s.value > 0.5 ? "elevated" : s.value < 0.2 ? "low" : "moderate"})`,
        s.value,
        ["signals"],
      );
    if (s.kind === "customer_concentration_pct")
      push(
        "sc.conc",
        "supply_chain",
        s.value > 30 ? -1 : 0,
        `${s.value.toFixed(1)}% of revenue from customers above 10% share`,
        s.value,
        ["signals"],
      );
    if (/^(customer|supplier)_momentum_3m$/.test(s.kind))
      push(
        `sc.${s.kind}`,
        "supply_chain",
        s.value,
        `${s.kind.startsWith("customer") ? "Customer" : "Supplier"} price momentum 3M ${fmt(s.value)}`,
        s.value,
        ["signals"],
      );
  }

  const [q0, q1] = research.shareholding;
  if (q0?.promoter != null && q1?.promoter != null)
    push(
      "sh.promoter",
      "shareholding",
      q0.promoter - q1.promoter,
      `Promoter holding ${q0.promoter.toFixed(2)}% (${(q0.promoter - q1.promoter).toFixed(2)} pp QoQ)`,
      q0.promoter,
      ["shareholding"],
    );
  if (q0?.fii != null && q1?.fii != null)
    push(
      "sh.fii",
      "shareholding",
      q0.fii - q1.fii,
      `FII holding ${q0.fii.toFixed(2)}% (${(q0.fii - q1.fii).toFixed(2)} pp QoQ)`,
      q0.fii,
      ["shareholding"],
    );
  if (q0?.pledge != null && q0.pledge > 0)
    push(
      "sh.pledge",
      "shareholding",
      -1,
      `${q0.pledge.toFixed(2)}% of promoter stake pledged`,
      q0.pledge,
      ["shareholding"],
    );
  if (research.target?.mean != null && research.price)
    push(
      "cons.target",
      "consensus",
      research.target.mean - research.price,
      `Consensus target implies ${fmt(((research.target.mean - research.price) / research.price) * 100)}`,
      research.target.mean,
      ["consensus"],
    );
  return out;
}

export function ruleVerdict(items: RuleInsight[]): {
  score: number;
  label: VerdictLabel;
  confidence: number;
} {
  const pos = items.filter((i) => i.tone === "positive").length;
  const neg = items.filter((i) => i.tone === "negative").length;
  const score = Math.max(5, Math.min(95, Math.round(50 + (pos - neg) * 6)));
  return {
    score,
    label: verdictLabelFor(score),
    confidence: Math.min(0.6, 0.15 + items.length * 0.03),
  };
}

function weekStart(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7));
  return t.toISOString().slice(0, 10);
}

function fillWeeks(rows: Array<{ week: string; count: number }>, weeks: number): WeeklyCount[] {
  const map = new Map(rows.map((r) => [String(r.week).slice(0, 10), Number(r.count)]));
  const out: WeeklyCount[] = [];
  const start = new Date(`${weekStart(new Date())}T00:00:00Z`);
  for (let i = weeks - 1; i >= 0; i--) {
    const w = new Date(start.getTime() - i * 7 * DAY).toISOString().slice(0, 10);
    out.push({ weekStart: w, count: map.get(w) ?? 0 });
  }
  return out;
}

async function altSignals(
  ctx: AppContext,
  companyId: number,
  prefix: string,
): Promise<SignalRow[]> {
  const rows = await ctx.db
    .selectDistinctOn([signals.kind])
    .from(signals)
    .where(and(eq(signals.companyId, companyId), sql`${signals.kind} like ${`${prefix}%`}`))
    .orderBy(signals.kind, desc(signals.asOf));
  return rows.map((r) => ({
    kind: r.kind,
    asOf: r.asOf,
    value: r.value ?? null,
    inputs: r.inputs as AltdataSignalInputs,
  }));
}

export async function companyTravel(
  ctx: AppContext,
  symbol: string,
): Promise<CompanyTravel | null> {
  const company = await findCompany(ctx, symbol);
  return ctx.api.getOrLoad(
    `ui:travel:${company.id}`,
    async () => {
      const planes = await ctx.db
        .select({ a: corporateAircraft })
        .from(corporateAircraft)
        .innerJoin(
          corporateAircraftCompanies,
          eq(corporateAircraftCompanies.aircraftId, corporateAircraft.id),
        )
        .where(
          and(
            eq(corporateAircraftCompanies.companyId, company.id),
            eq(corporateAircraft.active, true),
          ),
        );
      if (!planes.length) return null;
      const ids = planes.map((p) => p.a.id);
      const regById = new Map(planes.map((p) => [p.a.id, p.a.registration]));
      const since30 = daysAgo(30);
      const [legs, weekly, sig] = await Promise.all([
        ctx.db
          .select()
          .from(aircraftFlights)
          .where(
            and(
              inArray(aircraftFlights.aircraftId, ids),
              sql`coalesce(${aircraftFlights.departedAt}, ${aircraftFlights.arrivedAt}) >= ${since30.toISOString()}`,
            ),
          )
          .orderBy(desc(sql`coalesce(${aircraftFlights.departedAt}, ${aircraftFlights.arrivedAt})`))
          .limit(50),
        ctx.db.execute<{ week: string; count: number }>(sql`
          select to_char(date_trunc('week', coalesce(departed_at, arrived_at)), 'YYYY-MM-DD') week,
            count(*)::int count
          from aircraft_flights
          where aircraft_id in (${sql.join(
            ids.map((i) => sql`${i}`),
            sql`, `,
          )})
            and coalesce(departed_at, arrived_at) >= now() - interval '182 days'
          group by 1`),
        altSignals(ctx, company.id, "travel_"),
      ]);
      const place = (icao: string | null, city: string | null, country: string | null) =>
        icao ? { icao, iata: null, city: city ?? null, country: country ?? null } : null;
      const seen30 = planes.filter((p) => p.a.lastSeenAt && p.a.lastSeenAt >= since30).length;
      const lastSample = planes
        .map((p) => p.a.lastSeenAt)
        .filter((d): d is Date => d != null)
        .sort((x, y) => y.getTime() - x.getTime())[0];
      const verified = planes
        .map((p) => p.a.verifiedAt)
        .filter((d): d is Date => d != null)
        .sort((x, y) => y.getTime() - x.getTime())[0];
      return {
        aircraft: planes.map(({ a }) => ({
          registration: a.registration,
          icaoType: a.icaoType ?? null,
          model: a.model ?? null,
          groupName: a.groupName ?? null,
          linkedPerson: a.privacyFlagged ? null : (a.linkedPerson ?? null),
          linkedRole: a.linkedRole ?? null,
          tier: a.tier,
          confidence: a.confidence,
          privacyFlagged: a.privacyFlagged,
          lastSeenAt: iso(a.lastSeenAt),
          homeIcao: a.homeIcao ?? null,
        })),
        legs: legs.map((l) => ({
          id: l.id,
          registration: regById.get(l.aircraftId) ?? l.hex,
          departedAt: iso(l.departedAt),
          arrivedAt: iso(l.arrivedAt),
          durationMin: l.durationMin ?? null,
          dep: place(l.depIcao, l.depCity, l.depCountry),
          arr: place(l.arrIcao, l.arrCity, l.arrCountry),
          completeness: l.completeness,
          source: l.source,
        })),
        weeklyLegCounts: fillWeeks([...weekly], 26),
        signals: sig,
        coverage: {
          aircraftActive: planes.length,
          aircraftSeen30d: seen30,
          legsFull30d: legs.filter((l) => l.completeness === "full").length,
          legs30d: legs.length,
          lastSampleAt: iso(lastSample ?? null),
        },
        sources: [
          "adsb.lol",
          "OpenSky Network",
          ...new Set(planes.map((p) => p.a.sourceUrl).filter((u): u is string => !!u)),
        ],
        registryVerifiedAt: iso(verified ?? null),
      };
    },
    { ttlMs: 5 * MINUTE, staleMs: 30 * MINUTE },
  );
}

const BBL_PER_DWT = 7.33;

export async function companyLogistics(
  ctx: AppContext,
  symbol: string,
): Promise<CompanyLogistics | null> {
  const company = await findCompany(ctx, symbol);
  return ctx.api.getOrLoad(
    `ui:logistics:${company.id}`,
    async () => {
      const [sites, fleetRows] = await Promise.all([
        ctx.db
          .select({ f: facilities, fc: facilityCompanies })
          .from(facilityCompanies)
          .innerJoin(facilities, eq(facilities.id, facilityCompanies.facilityId))
          .where(and(eq(facilityCompanies.companyId, company.id), eq(facilities.active, true))),
        ctx.db.select().from(vesselFleet).where(eq(vesselFleet.companyId, company.id)),
      ]);
      if (!sites.length && !fleetRows.length) return null;
      const facIds = sites.map((s) => s.f.id);
      const slugById = new Map(sites.map((s) => [s.f.id, s.f.slug]));
      const since7 = daysAgo(7);
      const idList = facIds.length
        ? sql.join(
            facIds.map((i) => sql`${i}`),
            sql`, `,
          )
        : sql`null`;
      const [calls, weekly, open, transits, cov, sig, fleetSeen] = await Promise.all([
        facIds.length
          ? ctx.db
              .select({ c: vesselCalls, v: vessels })
              .from(vesselCalls)
              .innerJoin(vessels, eq(vessels.mmsi, vesselCalls.mmsi))
              .where(
                and(inArray(vesselCalls.facilityId, facIds), gte(vesselCalls.enteredAt, since7)),
              )
              .orderBy(desc(vesselCalls.enteredAt))
              .limit(50)
          : [],
        ctx.db.execute<{ facility_id: number; week: string; count: number }>(sql`
          select facility_id, to_char(date_trunc('week', entered_at), 'YYYY-MM-DD') week, count(*)::int count
          from vessel_calls where facility_id in (${idList}) and entered_at >= now() - interval '84 days'
          group by 1, 2`),
        facIds.length
          ? ctx.db
              .select({ c: vesselCalls, v: vessels })
              .from(vesselCalls)
              .innerJoin(vessels, eq(vessels.mmsi, vesselCalls.mmsi))
              .where(and(inArray(vesselCalls.facilityId, facIds), isNull(vesselCalls.leftAt)))
          : [],
        facIds.length
          ? ctx.db
              .select({ t: chokepointTransits, v: vessels })
              .from(chokepointTransits)
              .innerJoin(vessels, eq(vessels.mmsi, chokepointTransits.mmsi))
              .where(
                and(
                  inArray(chokepointTransits.destinationFacilityId, facIds),
                  gte(chokepointTransits.enteredAt, daysAgo(14)),
                ),
              )
              .orderBy(desc(chokepointTransits.enteredAt))
              .limit(30)
          : [],
        ctx.db
          .select()
          .from(altdataCoverage)
          .where(
            and(
              eq(altdataCoverage.layer, "ais"),
              gte(altdataCoverage.day, since7.toISOString().slice(0, 10)),
            ),
          ),
        altSignals(ctx, company.id, "logistics_"),
        fleetRows.length
          ? ctx.db
              .select({ mmsi: vessels.mmsi, imo: vessels.imo, lastSeenAt: vessels.lastSeenAt })
              .from(vessels)
              .where(
                inArray(
                  vessels.imo,
                  fleetRows.map((f) => f.imo),
                ),
              )
          : [],
      ]);
      const covByZone = new Map<string, { w: number; d: number }>();
      let w24 = 0;
      let d24 = 0;
      const today = new Date().toISOString().slice(0, 10);
      for (const c of cov) {
        const z = covByZone.get(c.zone) ?? { w: 0, d: 0 };
        z.w += c.windows;
        z.d += c.windowsWithData;
        covByZone.set(c.zone, z);
        if (c.day === today) {
          w24 += c.windows;
          d24 += c.windowsWithData;
        }
      }
      const totW = [...covByZone.values()].reduce((s, z) => s + z.w, 0);
      const totD = [...covByZone.values()].reduce((s, z) => s + z.d, 0);
      const mmsis = [
        ...new Set([
          ...calls.map((c) => c.v.mmsi),
          ...open.map((c) => c.v.mmsi),
          ...transits.map((t) => t.v.mmsi),
          ...fleetSeen.map((f) => f.mmsi),
        ]),
      ];
      const positions = mmsis.length
        ? await ctx.db
            .selectDistinctOn([vesselPositions.mmsi])
            .from(vesselPositions)
            .where(and(inArray(vesselPositions.mmsi, mmsis), gte(vesselPositions.ts, since7)))
            .orderBy(vesselPositions.mmsi, desc(vesselPositions.ts))
            .limit(200)
        : [];
      const classByMmsi = new Map<number, string>();
      for (const c of [...calls, ...open]) classByMmsi.set(c.v.mmsi, c.v.class);
      for (const t of transits) classByMmsi.set(t.v.mmsi, t.v.class);
      const lastSample = positions.map((p) => p.ts).sort((x, y) => y.getTime() - x.getTime())[0];
      const siteOf = (id: number) => sites.find((s) => s.f.id === id);
      return {
        facilities: sites.map(({ f, fc }) => {
          const z = covByZone.get(f.slug);
          return {
            id: f.id,
            slug: f.slug,
            name: f.name,
            kind: f.kind,
            lat: f.lat,
            lon: f.lon,
            radiusKm: f.radiusKm,
            role: fc.role,
            commodityIn: fc.commodityIn,
            commodityOut: fc.commodityOut,
            exclusive: f.exclusive,
            verifiedAt: iso(f.verifiedAt),
            coverage7d: z?.w ? z.d / z.w : null,
            arrivalsWeekly: fillWeeks(
              [...weekly].filter((r) => r.facility_id === f.id),
              12,
            ),
            activeVessels: open
              .filter((o) => o.c.facilityId === f.id)
              .map((o) => ({
                mmsi: o.v.mmsi,
                name: o.v.name ?? null,
                class: o.v.class,
                sizeClass: o.v.sizeClass ?? null,
                sinceAt: iso(o.c.enteredAt) ?? "",
                navStatus: o.c.navStatusMode ?? null,
              })),
          };
        }),
        calls: calls.map(({ c, v }) => {
          const site = siteOf(c.facilityId);
          const commodity =
            (c.cargoDirection === "load" ? site?.fc.commodityOut[0] : site?.fc.commodityIn[0]) ??
            null;
          const dwt = v.dwt ?? v.dwtEst ?? null;
          return {
            id: c.id,
            facilitySlug: slugById.get(c.facilityId) ?? "",
            mmsi: v.mmsi,
            name: v.name ?? null,
            class: v.class,
            sizeClass: v.sizeClass ?? null,
            enteredAt: iso(c.enteredAt) ?? "",
            leftAt: iso(c.leftAt),
            dwellMin: c.dwellMin ?? null,
            cargoDirection: c.cargoDirection ?? null,
            cargoProxy: {
              commodity,
              bbl: v.class === "tanker" && dwt ? Math.round(dwt * BBL_PER_DWT) : null,
            },
          };
        }),
        chokepointWatch: transits.map(({ t, v }) => ({
          mmsi: v.mmsi,
          name: v.name ?? null,
          class: v.class,
          sizeClass: v.sizeClass ?? null,
          chokepoint: t.chokepoint,
          loiterMin: t.loiterMin,
          destination: t.destinationAtEntry ?? null,
          destinationFacilitySlug: t.destinationFacilityId
            ? (slugById.get(t.destinationFacilityId) ?? null)
            : null,
          estValueCr: null,
          lastPositionAt: iso(v.lastSeenAt),
        })),
        fleet: fleetRows.length
          ? {
              size: fleetRows.length,
              seen7d: fleetSeen.filter((f) => f.lastSeenAt >= since7).length,
              vessels: fleetRows.map((f) => ({
                imo: f.imo,
                name: f.name,
                dwt: f.dwt ?? null,
                type: f.type ?? null,
              })),
            }
          : null,
        signals: sig,
        coverage: {
          factor7d: totW ? totD / totW : null,
          lastSampleAt: iso(lastSample ?? null),
          windows24h: w24,
          windowsWithData24h: d24,
        },
        positionsForMap: positions.map((p) => ({
          mmsi: p.mmsi,
          lat: p.lat,
          lon: p.lon,
          cogDeg: p.cogDeg ?? null,
          class: classByMmsi.get(p.mmsi) ?? "other",
          ts: iso(p.ts) ?? "",
        })),
        sources: [
          "aisstream.io",
          ...new Set(sites.map((s) => s.f.sourceUrl).filter((u): u is string => !!u)),
          ...new Set(fleetRows.map((f) => f.sourceUrl)),
        ],
      };
    },
    { ttlMs: 5 * MINUTE, staleMs: 30 * MINUTE },
  );
}

export async function altdataActivity(ctx: AppContext, limit = 40): Promise<AltdataActivityItem[]> {
  const rows = await ctx.api.getOrLoad(
    `ui:altdata:${limit}`,
    async () => {
      const rows = await ctx.db
        .select({
          e: altdataEvents,
          symbol: companies.nseSymbol,
          companyName: companies.name,
          facilitySlug: facilities.slug,
        })
        .from(altdataEvents)
        .leftJoin(companies, eq(companies.id, altdataEvents.companyId))
        .leftJoin(facilities, eq(facilities.id, altdataEvents.facilityId))
        .where(gte(altdataEvents.severity, 1))
        .orderBy(desc(altdataEvents.occurredAt))
        .limit(limit);
      return rows.map((r) => ({
        id: r.e.id,
        layer: r.e.layer,
        kind: r.e.kind,
        occurredAt: iso(r.e.occurredAt) ?? "",
        severity: r.e.severity,
        headline: r.e.headline,
        symbol: r.symbol ?? null,
        companyName: r.companyName ?? null,
        facilitySlug: r.facilitySlug ?? null,
        detail: r.e.detail,
      }));
    },
    { ttlMs: 5 * MINUTE, staleMs: 30 * MINUTE },
  );
  return rows ?? [];
}

export async function announcementDetail(ctx: AppContext, symbol: string, id: number) {
  const company = await findCompany(ctx, symbol);
  const [row] = await ctx.db
    .select()
    .from(announcements)
    .where(and(eq(announcements.companyId, company.id), eq(announcements.id, id)))
    .limit(1);
  return row ?? null;
}
