import { NotFoundError } from "@ma/core";
import {
  analystCalls,
  announcements,
  companies,
  desc,
  eq,
  fundamentals,
  inArray,
  or,
  PRICE_BASIS,
  pricesDaily,
  relationshipEstimates,
  relationships,
  signals,
  sql,
} from "@ma/db";
import type { YahooRange } from "@ma/ingest";
import type { AppContext } from "../context";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export type Company = typeof companies.$inferSelect;

export async function findCompany(ctx: AppContext, symbol: string): Promise<Company> {
  const sym = symbol.toUpperCase();
  const company = await ctx.api.getOrLoad(
    `company:${sym}`,
    () =>
      ctx.db.query.companies
        .findFirst({ where: eq(companies.nseSymbol, sym) })
        .then((c) => c ?? null),
    { ttlMs: HOUR, staleMs: 6 * HOUR, negativeTtlMs: MINUTE },
  );
  if (!company) throw new NotFoundError("company", sym);
  return company;
}

export async function searchCompanies(ctx: AppContext, q: string, limit = 12) {
  const term = q.trim().toUpperCase();
  if (!term) return [];
  return ctx.api.getOrLoad(
    `search:${term}:${limit}`,
    () =>
      ctx.db
        .select({
          nseSymbol: companies.nseSymbol,
          name: companies.name,
          sector: companies.sector,
          industry: companies.industry,
          marketCapCr: companies.marketCapCr,
        })
        .from(companies)
        .where(
          or(
            sql`${companies.nseSymbol} like ${`${term}%`}`,
            sql`upper(${companies.name}) like ${`%${term}%`}`,
          ),
        )
        .orderBy(
          sql`case when ${companies.nseSymbol} = ${term} then 0 when ${companies.nseSymbol} like ${`${term}%`} then 1 else 2 end`,
          desc(companies.marketCapCr),
        )
        .limit(limit),
    { ttlMs: 10 * MINUTE, staleMs: HOUR },
  );
}

export async function quoteFor(ctx: AppContext, yahooSymbol: string) {
  return ctx.api.getOrLoad(`quote:${yahooSymbol}`, () => ctx.yahoo.quote(yahooSymbol), {
    ttlMs: MINUTE,
    staleMs: 5 * MINUTE,
    negativeTtlMs: MINUTE,
  });
}

export async function companyOverview(ctx: AppContext, symbol: string) {
  const company = await findCompany(ctx, symbol);
  const [quote, latestAnnual, latestQuarter, signalRows] = await Promise.all([
    company.yahooSymbol ? quoteFor(ctx, company.yahooSymbol) : null,
    ctx.db.query.fundamentals.findFirst({
      where: (f, { and, eq }) => and(eq(f.companyId, company.id), eq(f.periodType, "annual")),
      orderBy: desc(fundamentals.periodEnd),
    }),
    ctx.db.query.fundamentals.findFirst({
      where: (f, { and, eq }) => and(eq(f.companyId, company.id), eq(f.periodType, "quarterly")),
      orderBy: desc(fundamentals.periodEnd),
    }),
    latestSignals(ctx, company.id),
  ]);
  return { company, quote, latestAnnual, latestQuarter, signals: signalRows };
}

export async function latestSignals(ctx: AppContext, companyId: number) {
  return ctx.api.getOrLoad(
    `signals:${companyId}`,
    () =>
      ctx.db
        .selectDistinctOn([signals.kind])
        .from(signals)
        .where(eq(signals.companyId, companyId))
        .orderBy(signals.kind, desc(signals.asOf), desc(signals.modelVersion)),
    { ttlMs: 15 * MINUTE, staleMs: HOUR },
  );
}

const RANGE_DAYS: Record<YahooRange, number> = {
  "5d": 7,
  "1mo": 31,
  "3mo": 92,
  "6mo": 183,
  "1y": 366,
  "2y": 731,
  "5y": 1827,
  max: 36_500,
};

export async function priceHistory(ctx: AppContext, symbol: string, range: YahooRange) {
  const company = await findCompany(ctx, symbol);
  const from = new Date(Date.now() - RANGE_DAYS[range] * 86_400_000).toISOString().slice(0, 10);
  return ctx.api.getOrLoad(
    `prices:${company.id}:${range}`,
    () =>
      ctx.db
        .select({
          date: pricesDaily.date,
          open: pricesDaily.open,
          high: pricesDaily.high,
          low: pricesDaily.low,
          close: pricesDaily.close,
          adjClose: pricesDaily.adjClose,
          volume: pricesDaily.volume,
        })
        .from(pricesDaily)
        .where(sql`${pricesDaily.companyId} = ${company.id} and ${pricesDaily.date} >= ${from}`)
        .orderBy(pricesDaily.date),
    { ttlMs: 15 * MINUTE, staleMs: 2 * HOUR },
  );
}

export interface PriceHistoryMeta {
  priceBasis: typeof PRICE_BASIS;
  generation: number | null;
  quality: string | null;
  finalThrough: string | null;
  verifiedThrough: string | null;
  openGaps: number;
  missingSessions: number;
}

export async function priceHistoryMeta(
  ctx: AppContext,
  symbol: string,
): Promise<PriceHistoryMeta | null> {
  const company = await findCompany(ctx, symbol);
  return ctx.api.getOrLoad(
    `prices:${company.id}:meta`,
    async () => {
      const rows = await ctx.db.execute<{
        generation: number;
        quality: string;
        verified_through: string | null;
        final_through: string | null;
        open_gaps: number;
        missing_sessions: number;
      }>(sql`
        select s.adjustment_generation as generation, s.quality_status as quality,
               s.verified_through::text,
               (select max(p.date)::text from prices_daily p
                 where p.company_id = s.company_id and p.is_final
                   and p.adjustment_generation = s.adjustment_generation) as final_through,
               (select count(*)::int from price_gaps g
                 where g.series_id = s.id and g.status = 'open') as open_gaps,
               (select coalesce(sum(g.sessions), 0)::int from price_gaps g
                 where g.series_id = s.id and g.status = 'open') as missing_sessions
        from price_series_state s where s.company_id = ${company.id}`);
      const r = rows[0];
      return {
        priceBasis: PRICE_BASIS,
        generation: r ? Number(r.generation) : null,
        quality: r?.quality ?? null,
        finalThrough: r?.final_through ?? null,
        verifiedThrough: r?.verified_through ?? null,
        openGaps: Number(r?.open_gaps ?? 0),
        missingSessions: Number(r?.missing_sessions ?? 0),
      };
    },
    { ttlMs: 15 * MINUTE, staleMs: 2 * HOUR },
  );
}

export async function financials(ctx: AppContext, symbol: string) {
  const company = await findCompany(ctx, symbol);
  return ctx.api.getOrLoad(
    `financials:${company.id}`,
    async () => {
      const rows = await ctx.db
        .select()
        .from(fundamentals)
        .where(eq(fundamentals.companyId, company.id))
        .orderBy(fundamentals.periodEnd);
      return {
        annual: rows.filter((r) => r.periodType === "annual"),
        quarterly: rows.filter((r) => r.periodType === "quarterly").slice(-12),
      };
    },
    { ttlMs: HOUR, staleMs: 12 * HOUR },
  );
}

const RATING_BUCKET: Array<[RegExp, "strongBuy" | "buy" | "hold" | "sell"]> = [
  [/strong buy/i, "strongBuy"],
  [/buy|outperform|accumulate|add|overweight/i, "buy"],
  [/hold|neutral|equal|market perform/i, "hold"],
  [/sell|reduce|underperform|underweight/i, "sell"],
];

export async function analystView(ctx: AppContext, symbol: string, months = 6) {
  const company = await findCompany(ctx, symbol);
  return ctx.api.getOrLoad(
    `analysts:${company.id}:${months}`,
    async () => {
      const since = new Date(Date.now() - months * 30 * 86_400_000).toISOString().slice(0, 10);
      const calls = await ctx.db
        .select()
        .from(analystCalls)
        .where(
          sql`${analystCalls.companyId} = ${company.id} and ${analystCalls.publishedAt} >= ${since}`,
        )
        .orderBy(desc(analystCalls.publishedAt));
      const latestByBroker = new Map<string, (typeof calls)[number]>();
      for (const c of calls) if (!latestByBroker.has(c.broker)) latestByBroker.set(c.broker, c);
      const current = [...latestByBroker.values()];
      const targets = current
        .map((c) => c.targetPrice)
        .filter((t): t is number => t != null && t > 0)
        .sort((a, b) => a - b);
      const counts = { strongBuy: 0, buy: 0, hold: 0, sell: 0 };
      for (const c of current) {
        const bucket = RATING_BUCKET.find(([re]) => re.test(c.rating))?.[1];
        if (bucket) counts[bucket]++;
      }
      const quote = company.yahooSymbol ? await quoteFor(ctx, company.yahooSymbol) : null;
      const avg = targets.length ? targets.reduce((s, t) => s + t, 0) / targets.length : null;
      return {
        calls,
        summary: {
          brokers: current.length,
          avgTarget: avg,
          lowTarget: targets[0] ?? null,
          medianTarget: targets.length
            ? (targets[Math.floor((targets.length - 1) / 2)] as number)
            : null,
          highTarget: targets.at(-1) ?? null,
          price: quote?.price ?? null,
          upsidePct: avg != null && quote?.price ? ((avg - quote.price) / quote.price) * 100 : null,
          counts,
        },
      };
    },
    { ttlMs: 10 * MINUTE, staleMs: HOUR },
  );
}

export async function latestAnalystCalls(ctx: AppContext, limit = 50) {
  return ctx.api.getOrLoad(
    `analysts:latest:${limit}`,
    () =>
      ctx.db
        .select({
          id: analystCalls.id,
          symbol: companies.nseSymbol,
          name: companies.name,
          broker: analystCalls.broker,
          publishedAt: analystCalls.publishedAt,
          action: analystCalls.action,
          rating: analystCalls.rating,
          priorRating: analystCalls.priorRating,
          targetPrice: analystCalls.targetPrice,
          priorTargetPrice: analystCalls.priorTargetPrice,
          priceAtCall: analystCalls.priceAtCall,
          reportUrl: analystCalls.reportUrl,
          title: analystCalls.title,
          summary: analystCalls.summary,
          reportDocumentId: analystCalls.reportDocumentId,
          thesis: analystCalls.thesis,
        })
        .from(analystCalls)
        .innerJoin(companies, eq(companies.id, analystCalls.companyId))
        .orderBy(desc(analystCalls.publishedAt), desc(analystCalls.id))
        .limit(limit),
    { ttlMs: 5 * MINUTE, staleMs: 30 * MINUTE },
  );
}

export async function supplyChain(ctx: AppContext, symbol: string) {
  const company = await findCompany(ctx, symbol);
  return ctx.api.getOrLoad(
    `supply-chain:${company.id}`,
    async () => {
      const today = new Date().toISOString().slice(0, 10);
      const rows = await ctx.db
        .select({
          id: relationships.id,
          supplierCompanyId: relationships.supplierCompanyId,
          supplierName: relationships.supplierName,
          customerCompanyId: relationships.customerCompanyId,
          customerName: relationships.customerName,
          costBucket: relationships.costBucket,
          disclosureKind: relationships.disclosureKind,
          disclosedPct: relationships.disclosedPct,
          fiscalYear: relationships.fiscalYear,
          validFrom: relationships.validFrom,
          validTo: relationships.validTo,
          confidence: relationships.confidence,
          evidence: relationships.evidence,
          method: relationshipEstimates.method,
          valueCr: relationshipEstimates.valueCr,
          valueLowCr: relationshipEstimates.valueLowCr,
          valueHighCr: relationshipEstimates.valueHighCr,
          supplierRevenuePct: relationshipEstimates.supplierRevenuePct,
          customerCostPct: relationshipEstimates.customerCostPct,
        })
        .from(relationships)
        .leftJoin(
          relationshipEstimates,
          sql`${relationshipEstimates.relationshipId} = ${relationships.id} and ${relationshipEstimates.id} = (select id from relationship_estimates re where re.relationship_id = ${relationships.id} order by as_of desc, model_version desc limit 1)`,
        )
        .where(
          sql`(${relationships.supplierCompanyId} = ${company.id} or ${relationships.customerCompanyId} = ${company.id}) and ${relationships.validTo} >= ${today}`,
        )
        .orderBy(desc(relationshipEstimates.valueCr), desc(relationships.confidence));
      const counterpartyIds = [
        ...new Set(
          rows
            .flatMap((r) => [r.supplierCompanyId, r.customerCompanyId])
            .filter((id): id is number => id != null && id !== company.id),
        ),
      ];
      const symbols = counterpartyIds.length
        ? await ctx.db
            .select({ id: companies.id, nseSymbol: companies.nseSymbol })
            .from(companies)
            .where(inArray(companies.id, counterpartyIds))
        : [];
      const symbolById = new Map(symbols.map((s) => [s.id, s.nseSymbol]));
      const decorate = (r: (typeof rows)[number], otherId: number | null) => ({
        ...r,
        counterpartySymbol: otherId ? (symbolById.get(otherId) ?? null) : null,
      });
      return {
        customers: rows
          .filter((r) => r.supplierCompanyId === company.id)
          .map((r) => decorate(r, r.customerCompanyId)),
        suppliers: rows
          .filter((r) => r.customerCompanyId === company.id)
          .map((r) => decorate(r, r.supplierCompanyId)),
        signals: ((await latestSignals(ctx, company.id)) ?? []).filter((s) =>
          /customer|supplier|distress/.test(s.kind),
        ),
      };
    },
    { ttlMs: 30 * MINUTE, staleMs: 6 * HOUR },
  );
}

export async function companyAnnouncements(ctx: AppContext, symbol: string, limit = 40) {
  const company = await findCompany(ctx, symbol);
  return ctx.api.getOrLoad(
    `announcements:${company.id}:${limit}`,
    () =>
      ctx.db
        .select()
        .from(announcements)
        .where(eq(announcements.companyId, company.id))
        .orderBy(desc(announcements.publishedAt))
        .limit(limit),
    { ttlMs: 10 * MINUTE, staleMs: HOUR },
  );
}

export async function signalLeaderboard(
  ctx: AppContext,
  kind: string,
  limit = 50,
  order: "asc" | "desc" = "desc",
) {
  return ctx.api.getOrLoad(
    `leaderboard:${kind}:${order}:${limit}`,
    () =>
      ctx.db
        .select({
          symbol: companies.nseSymbol,
          name: companies.name,
          sector: companies.sector,
          asOf: signals.asOf,
          value: signals.value,
          inputs: signals.inputs,
        })
        .from(signals)
        .innerJoin(companies, eq(companies.id, signals.companyId))
        .where(
          sql`${signals.kind} = ${kind} and (${signals.asOf}, ${signals.modelVersion}) = (select as_of, model_version from signals s2 where s2.company_id = ${signals.companyId} and s2.kind = ${kind} order by as_of desc, model_version desc limit 1)`,
        )
        .orderBy(order === "desc" ? desc(signals.value) : signals.value)
        .limit(limit),
    { ttlMs: 15 * MINUTE, staleMs: 2 * HOUR },
  );
}

export const WORLD_INDICES = [
  { symbol: "^NSEI", name: "NIFTY 50", region: "IN" },
  { symbol: "^BSESN", name: "SENSEX", region: "IN" },
  { symbol: "^NSEBANK", name: "NIFTY BANK", region: "IN" },
  { symbol: "^CNXIT", name: "NIFTY IT", region: "IN" },
  { symbol: "^INDIAVIX", name: "INDIA VIX", region: "IN" },
  { symbol: "^GSPC", name: "S&P 500", region: "US" },
  { symbol: "^IXIC", name: "NASDAQ", region: "US" },
  { symbol: "^DJI", name: "DOW JONES", region: "US" },
  { symbol: "^N225", name: "NIKKEI 225", region: "JP" },
  { symbol: "^HSI", name: "HANG SENG", region: "HK" },
  { symbol: "000001.SS", name: "SHANGHAI", region: "CN" },
  { symbol: "^FTSE", name: "FTSE 100", region: "UK" },
  { symbol: "^GDAXI", name: "DAX", region: "DE" },
  { symbol: "USDINR=X", name: "USD/INR", region: "FX" },
  { symbol: "BZ=F", name: "BRENT", region: "CMD" },
  { symbol: "GC=F", name: "GOLD", region: "CMD" },
  { symbol: "^TNX", name: "US 10Y", region: "RATES" },
] as const;

export async function marketOverview(ctx: AppContext) {
  const quotes = await Promise.all(
    WORLD_INDICES.map(async (i) => {
      const q = await quoteFor(ctx, i.symbol).catch(() => null);
      return {
        ...i,
        price: q?.price ?? null,
        change: q?.change ?? null,
        changePct: q?.changePct ?? null,
        marketState: q?.marketState ?? null,
        marketTime: q?.marketTime ?? null,
      };
    }),
  );
  return { indices: quotes, asOf: new Date().toISOString() };
}

export async function movers(ctx: AppContext, limit = 10) {
  return ctx.api.getOrLoad(
    `movers:${limit}`,
    async () => {
      const rows = await ctx.db.execute<{
        symbol: string;
        name: string;
        close: number;
        prev: number;
        date: string;
      }>(sql`
        with latest as (
          select company_id, max(date) d from prices_daily group by company_id
        ), ranked as (
          select p.company_id, p.date, p.close,
                 lag(p.close) over (partition by p.company_id order by p.date) prev
          from prices_daily p
          where p.date >= (select max(d) from latest) - interval '10 days'
        )
        select c.nse_symbol symbol, c.name, r.close, r.prev, r.date
        from ranked r join latest l on l.company_id = r.company_id and l.d = r.date
        join companies c on c.id = r.company_id
        join index_constituents ic on ic.company_id = c.id join indices i on i.id = ic.index_id and i.code = 'NIFTY50'
        where r.prev is not null and r.prev > 0`);
      const withChange = rows
        .map((r) => ({
          ...r,
          changePct: ((Number(r.close) - Number(r.prev)) / Number(r.prev)) * 100,
        }))
        .sort((a, b) => b.changePct - a.changePct);
      return {
        gainers: withChange.slice(0, limit),
        losers: withChange.slice(-limit).reverse(),
        date: withChange[0]?.date ?? null,
      };
    },
    { ttlMs: 15 * MINUTE, staleMs: 2 * HOUR },
  );
}
