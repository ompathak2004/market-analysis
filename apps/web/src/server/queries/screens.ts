import { analystCalls, and, announcements, companies, desc, eq, gte, sql } from "@ma/db";
import type { BrokerThesis, RuleInsight, VerdictLabel } from "@ma/intel";
import { verdictLabelFor } from "@ma/intel";
import type { AppContext } from "../context";
import { analystView, companyOverview, financials, findCompany, priceHistory } from "./core";
import type {
  BrokerCall,
  CompanyCalls,
  FilingItem,
  KeyStats,
  LatestBrokerCall,
  Peer,
  QuoteView,
  RangeStats,
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

export async function companyCalls(ctx: AppContext, symbol: string): Promise<CompanyCalls> {
  const view = await analystView(ctx, symbol, 12);
  return { calls: (view?.calls ?? []).map(callOf), price: view?.summary.price ?? null };
}

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

export async function announcementDetail(ctx: AppContext, symbol: string, id: number) {
  const company = await findCompany(ctx, symbol);
  const [row] = await ctx.db
    .select()
    .from(announcements)
    .where(and(eq(announcements.companyId, company.id), eq(announcements.id, id)))
    .limit(1);
  return row ?? null;
}
