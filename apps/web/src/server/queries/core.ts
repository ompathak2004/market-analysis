import { NotFoundError } from "@ma/core";
import {
  analystCalls,
  and,
  announcements,
  companies,
  type counterparties,
  desc,
  eq,
  fundamentals,
  or,
  PRICE_BASIS,
  type relationshipEstimates,
  type relationships,
  signals,
  sql,
} from "@ma/db";
import type { YahooRange } from "@ma/ingest";
import { activeSignalVersionClause, ESTIMATE_MODEL_VERSION } from "@ma/intel";
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
        .where(
          and(
            eq(signals.companyId, companyId),
            activeSignalVersionClause(sql`${signals.kind}`, sql`${signals.modelVersion}`),
          ),
        )
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

export interface PriceBar {
  date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number;
  adjClose: number | null;
  volume: number | null;
  final: boolean;
}

export interface PriceHistoryMeta {
  priceBasis: typeof PRICE_BASIS;
  generation: number | null;
  quality: string | null;
  exceptionReason: string | null;
  finalThrough: string | null;
  verifiedThrough: string | null;
  openGaps: number;
  missingSessions: number;
  provisional: "flagged";
}

export interface PriceSnapshot {
  bars: PriceBar[];
  meta: PriceHistoryMeta;
}

export async function priceSnapshot(
  ctx: AppContext,
  symbol: string,
  range: YahooRange,
): Promise<PriceSnapshot | null> {
  const company = await findCompany(ctx, symbol);
  const from = new Date(Date.now() - RANGE_DAYS[range] * 86_400_000).toISOString().slice(0, 10);
  return ctx.api.getOrLoad(
    `prices:${company.id}:${range}:snapshot`,
    async () => {
      const rows = await ctx.db.execute<{
        generation: number | null;
        quality: string | null;
        exception_reason: string | null;
        verified_through: string | null;
        final_through: string | null;
        open_gaps: number;
        missing_sessions: number;
        bars: PriceBar[];
      }>(sql`
        with s as (
          select id, adjustment_generation, quality_status, exception_reason, verified_through
          from price_series_state where company_id = ${company.id}
        ), g as (
          select coalesce(
            (select adjustment_generation from s),
            (select max(adjustment_generation) from prices_daily where company_id = ${company.id})
          ) as generation
        )
        select g.generation,
               (select quality_status from s) as quality,
               (select exception_reason from s) as exception_reason,
               (select verified_through::text from s) as verified_through,
               (select max(p.date)::text from prices_daily p
                 where p.company_id = ${company.id} and p.is_final
                   and p.adjustment_generation = g.generation) as final_through,
               (select count(*)::int from price_gaps x
                 where x.series_id = (select id from s) and x.status = 'open') as open_gaps,
               (select coalesce(sum(x.sessions), 0)::int from price_gaps x
                 where x.series_id = (select id from s) and x.status = 'open') as missing_sessions,
               coalesce((
                 select json_agg(json_build_object(
                   'date', p.date::text, 'open', p.open, 'high', p.high, 'low', p.low,
                   'close', p.close, 'adjClose', p.adj_close, 'volume', p.volume,
                   'final', p.is_final) order by p.date)
                 from prices_daily p
                 where p.company_id = ${company.id} and p.adjustment_generation = g.generation
                   and p.date >= ${from}
               ), '[]'::json) as bars
        from g`);
      const r = rows[0];
      return {
        bars: r?.bars ?? [],
        meta: {
          priceBasis: PRICE_BASIS,
          generation: r?.generation == null ? null : Number(r.generation),
          quality: r?.quality ?? null,
          exceptionReason: r?.exception_reason ?? null,
          finalThrough: r?.final_through ?? null,
          verifiedThrough: r?.verified_through ?? null,
          openGaps: Number(r?.open_gaps ?? 0),
          missingSessions: Number(r?.missing_sessions ?? 0),
          provisional: "flagged",
        },
      };
    },
    { ttlMs: 15 * MINUTE, staleMs: 2 * HOUR },
  );
}

export async function priceHistory(
  ctx: AppContext,
  symbol: string,
  range: YahooRange,
): Promise<PriceBar[] | null> {
  return (await priceSnapshot(ctx, symbol, range))?.bars ?? null;
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

export type ValueBasis = (typeof relationships.$inferSelect)["valueBasis"];
export type CostBucket = (typeof relationships.$inferSelect)["costBucket"];
export type CounterpartyKind = (typeof counterparties.$inferSelect)["kind"];
export type EstimateMethod = (typeof relationshipEstimates.$inferSelect)["method"];

export interface Counterparty {
  id: number;
  kind: CounterpartyKind;
  name: string;
  symbol: string | null;
}

export interface SupplyChainEvidence {
  observationId: number;
  quote: string;
  page: number | null;
  documentId: number;
  source: string;
  url: string;
  publishedAt: string | null;
  extractorFamily: string;
}

export interface SupplyChainEstimate {
  method: EstimateMethod;
  valueBasis: ValueBasis;
  valueCr: number | null;
  lowCr: number | null;
  highCr: number | null;
  supplierRevenuePct: number | null;
  customerCostPct: number | null;
  asOf: string;
  modelVersion: number;
}

export interface SupplyChainEdge {
  id: number;
  counterparty: Counterparty;
  valueBasis: ValueBasis;
  costBucket: CostBucket;
  disclosedBy: (typeof relationships.$inferSelect)["disclosedBy"];
  disclosureKind: (typeof relationships.$inferSelect)["disclosureKind"];
  disclosedPct: number | null;
  period: { start: string | null; end: string | null; fiscalYear: number | null };
  confidence: number;
  status: "active" | "expired";
  lastDisclosedAt: string | null;
  validTo: string | null;
  observationCount: number;
  estimate: SupplyChainEstimate | null;
  contractTotalCr: number | null;
  evidence: SupplyChainEvidence[];
}

export interface SupplyChainCoverageFamily {
  family: string;
  available: number;
  read: number;
  lastReadAt: string | null;
}

export interface SupplyChainCoverage {
  families: SupplyChainCoverageFamily[];
  available: number;
  read: number;
  lastReadAt: string | null;
  graphRevision: number | null;
  rebuiltAt: string | null;
  extractorVersion: number | null;
}

export type ChainSignal = NonNullable<Awaited<ReturnType<typeof latestSignals>>>[number];

export interface SupplyChainResponse {
  schemaVersion: 2;
  company: { id: number; symbol: string };
  customers: SupplyChainEdge[];
  suppliers: SupplyChainEdge[];
  totals: { customers: number; suppliers: number };
  coverage: SupplyChainCoverage;
  signals: ChainSignal[];
}

const EDGE_LIMIT = 200;

type EdgeRow = {
  id: number;
  side: "customer" | "supplier";
  total: number;
  counterparty: Counterparty;
  value_basis: ValueBasis;
  cost_bucket: CostBucket;
  disclosed_by: SupplyChainEdge["disclosedBy"];
  disclosure_kind: SupplyChainEdge["disclosureKind"];
  disclosed_pct: number | null;
  disclosed_value: string | null;
  fiscal_year: number | null;
  valid_from: string | null;
  valid_to: string | null;
  confidence: number;
  status: "active" | "expired";
  last_disclosed_at: string | null;
  observation_count: number;
  period_start: string | null;
  period_end: string | null;
  observed_fiscal_year: number | null;
  estimate: SupplyChainEstimate | null;
  contract_cr: string | null;
  evidence: SupplyChainEvidence[] | null;
};

function edgeFrom(r: EdgeRow): SupplyChainEdge {
  const contract = r.contract_cr ?? (r.value_basis === "contract_total" ? r.disclosed_value : null);
  return {
    id: Number(r.id),
    counterparty: r.counterparty,
    valueBasis: r.value_basis,
    costBucket: r.cost_bucket,
    disclosedBy: r.disclosed_by,
    disclosureKind: r.disclosure_kind,
    disclosedPct: r.disclosed_pct == null ? null : Number(r.disclosed_pct),
    period: {
      start: r.period_start ?? r.valid_from ?? null,
      end: r.period_end ?? null,
      fiscalYear: r.observed_fiscal_year ?? r.fiscal_year ?? null,
    },
    confidence: Number(r.confidence),
    status: r.status,
    lastDisclosedAt: r.last_disclosed_at ?? null,
    validTo: r.valid_to ?? null,
    observationCount: Number(r.observation_count),
    estimate: r.estimate ?? null,
    contractTotalCr: contract == null ? null : Number(contract),
    evidence: r.evidence ?? [],
  };
}

function coverageFrom(
  c:
    | (Omit<SupplyChainCoverage, "available" | "read" | "lastReadAt"> & {
        documentsAvailable: number | null;
        documentsRead: number | null;
      })
    | undefined,
): SupplyChainCoverage {
  const families = c?.families ?? [];
  const lastReadAt = families.reduce<string | null>(
    (latest, f) =>
      f.lastReadAt && (!latest || Date.parse(f.lastReadAt) > Date.parse(latest))
        ? f.lastReadAt
        : latest,
    null,
  );
  return {
    families,
    available: families.length
      ? families.reduce((s, f) => s + f.available, 0)
      : Number(c?.documentsAvailable ?? 0),
    read: families.length
      ? families.reduce((s, f) => s + f.read, 0)
      : Number(c?.documentsRead ?? 0),
    lastReadAt,
    graphRevision: c?.graphRevision ?? null,
    rebuiltAt: c?.rebuiltAt ?? null,
    extractorVersion: c?.extractorVersion ?? null,
  };
}

const LIVE_OBSERVATION = sql.raw(`('pending', 'auto', 'confirmed')`);

export async function supplyChain(ctx: AppContext, symbol: string): Promise<SupplyChainResponse> {
  const company = await findCompany(ctx, symbol);
  const chain = await ctx.api.getOrLoad(
    `${supplyChainKey(company.id)}v2`,
    async () => {
      const today = new Date().toISOString().slice(0, 10);
      const [edges, coverage, chainSignals] = await Promise.all([
        ctx.db.execute<EdgeRow>(sql`
          with me as (
            select id from counterparties where company_id = ${company.id}
          ), e as (
            select r.*,
                   case when r.supplier_company_id = ${company.id}
                          or r.supplier_counterparty_id = (select id from me)
                        then 'customer' else 'supplier' end as side
            from relationships r
            where r.status in ('active', 'expired')
              and r.supplier_counterparty_id is not null
              and r.customer_counterparty_id is not null
              and (r.valid_to is null or r.valid_to >= ${today}::date)
              and (r.supplier_company_id = ${company.id} or r.customer_company_id = ${company.id}
                or r.supplier_counterparty_id = (select id from me)
                or r.customer_counterparty_id = (select id from me))
          ), ranked as (
            select e.*, est.estimate, ct.value_cr as contract_cr,
                   row_number() over (
                     partition by e.side
                     order by est.value_cr desc nulls last, e.confidence desc, e.id
                   ) as rn,
                   count(*) over (partition by e.side)::int as total
            from e
            left join lateral (
              select x.value_cr, json_build_object(
                       'method', x.method, 'valueBasis', x.value_basis, 'valueCr', x.value_cr,
                       'lowCr', x.value_low_cr, 'highCr', x.value_high_cr,
                       'supplierRevenuePct', x.supplier_revenue_pct,
                       'customerCostPct', x.customer_cost_pct,
                       'asOf', x.as_of, 'modelVersion', x.model_version) as estimate
              from relationship_estimates x
              where x.relationship_id = e.id and x.value_basis <> 'contract_total'
              order by (x.model_version = ${ESTIMATE_MODEL_VERSION}) desc, x.as_of desc,
                       x.model_version desc, x.id desc
              limit 1
            ) est on true
            left join lateral (
              select x.value_cr
              from relationship_estimates x
              where x.relationship_id = e.id and x.value_basis = 'contract_total'
              order by x.as_of desc, x.model_version desc, x.id desc
              limit 1
            ) ct on true
          )
          select k.id, k.side, k.total, k.value_basis, k.cost_bucket, k.disclosed_by,
                 k.disclosure_kind, k.disclosed_pct, k.disclosed_value::text as disclosed_value,
                 k.fiscal_year, k.valid_from::text as valid_from, k.valid_to::text as valid_to,
                 k.confidence, k.status, k.last_disclosed_at::text as last_disclosed_at,
                 k.observation_count, k.estimate, k.contract_cr::text as contract_cr,
                 b.period_start::text as period_start, b.period_end::text as period_end,
                 b.fiscal_year as observed_fiscal_year,
                 json_build_object('id', c.id, 'kind', c.kind, 'name', c.canonical_name,
                                   'symbol', co.nse_symbol) as counterparty,
                 ev.evidence
          from ranked k
          join counterparties c on c.id = case when k.side = 'customer'
                                               then k.customer_counterparty_id
                                               else k.supplier_counterparty_id end
          left join companies co on co.id = c.company_id
          left join lateral (
            select o.period_start, o.period_end, o.fiscal_year
            from relationship_observations o
            where o.supplier_counterparty_id = k.supplier_counterparty_id
              and o.customer_counterparty_id = k.customer_counterparty_id
              and o.cost_bucket = k.cost_bucket
              and o.status in ${LIVE_OBSERVATION}
            order by (o.status = 'confirmed') desc, o.confidence desc,
                     o.period_end desc nulls last, o.id desc
            limit 1
          ) b on true
          left join lateral (
            select json_agg(json_build_object(
                     'observationId', x.id, 'quote', x.quote, 'page', x.page,
                     'documentId', x.document_id, 'source', x.source, 'url', x.url,
                     'publishedAt', x.published_at, 'extractorFamily', x.extractor_family)
                   order by x.ord) as evidence
            from (
              select o.id, sp.quote, sp.page, sp.document_id, sp.source, sp.url,
                     sp.published_at, ex.extractor_family,
                     row_number() over (
                       order by (o.status = 'confirmed') desc, o.confidence desc,
                                sp.published_at desc nulls last, o.id desc
                     ) as ord
              from relationship_observations o
              join relationship_extractions ex on ex.id = o.extraction_id
              join lateral (
                select s.quote, s.page, d.id as document_id, d.source, d.url,
                       coalesce(dr.published_at, d.published_at) as published_at
                from relationship_observation_evidence oe
                join evidence_spans s on s.id = oe.evidence_span_id
                join document_revisions dr on dr.id = s.document_revision_id
                join documents d on d.id = dr.document_id
                where oe.observation_id = o.id
                order by s.id
                limit 1
              ) sp on true
              where o.supplier_counterparty_id = k.supplier_counterparty_id
                and o.customer_counterparty_id = k.customer_counterparty_id
                and o.cost_bucket = k.cost_bucket
                and o.status in ${LIVE_OBSERVATION}
              order by ord
              limit 3
            ) x
          ) ev on true
          where k.rn <= ${EDGE_LIMIT}
          order by k.side, k.rn`),
        ctx.db.execute<{
          coverage: Omit<SupplyChainCoverage, "available" | "read" | "lastReadAt"> & {
            documentsAvailable: number | null;
            documentsRead: number | null;
          };
        }>(sql`
          select json_build_object(
                   'families', coalesce((
                     select json_agg(json_build_object(
                              'family', f.family, 'available', f.available, 'read', f.read,
                              'lastReadAt', f.last_read_at) order by f.family)
                     from (
                       select s.family::text as family, count(*)::int as available,
                              count(*) filter (where s.read_revision_id is not null)::int as read,
                              max(s.last_read_at) as last_read_at
                       from relationship_sources s
                       where s.company_id = ${company.id} and s.family <> 'legacy'
                       group by s.family
                     ) f
                   ), '[]'::json),
                   'documentsAvailable', g.documents_available,
                   'documentsRead', g.documents_read,
                   'graphRevision', g.graph_revision,
                   'rebuiltAt', g.rebuilt_at,
                   'extractorVersion', g.extractor_version) as coverage
          from (select 1) one
          left join company_graph_state g on g.company_id = ${company.id}`),
        latestSignals(ctx, company.id),
      ]);
      const rows = [...edges];
      const totalFor = (side: EdgeRow["side"]) =>
        Number(rows.find((r) => r.side === side)?.total ?? 0);
      return {
        schemaVersion: 2 as const,
        company: { id: company.id, symbol: company.nseSymbol ?? symbol.toUpperCase() },
        customers: rows.filter((r) => r.side === "customer").map(edgeFrom),
        suppliers: rows.filter((r) => r.side === "supplier").map(edgeFrom),
        totals: { customers: totalFor("customer"), suppliers: totalFor("supplier") },
        coverage: coverageFrom(coverage[0]?.coverage),
        signals: (chainSignals ?? []).filter((s) => /customer|supplier|distress/.test(s.kind)),
      };
    },
    { ttlMs: 30 * MINUTE, staleMs: 6 * HOUR },
  );
  if (!chain) throw new NotFoundError("supply-chain", company.nseSymbol ?? symbol);
  return chain;
}

export function supplyChainKey(companyId: number): string {
  return `supply-chain:${companyId}:`;
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
          sql`${signals.kind} = ${kind} and (${signals.asOf}, ${signals.modelVersion}) = (select as_of, model_version from signals s2 where s2.company_id = ${signals.companyId} and s2.kind = ${kind} and ${activeSignalVersionClause(sql`s2.kind`, sql`s2.model_version`)} order by as_of desc, model_version desc limit 1)`,
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
