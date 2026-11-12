import { sql } from "@ma/db";
import { activeSignalVersionClause } from "@ma/intel";
import type { AppContext } from "../context";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export interface BotSecurity {
  companyId: number;
  symbol: string;
  name: string;
  sector: string | null;
  industry: string | null;
  marketCapCr: number | null;
  closes: Array<{ date: string; close: number }>;
}

export interface BotMarket {
  securities: BotSecurity[];
  splits: Array<{ symbol: string; exDate: string; ratio: number }>;
  dividends: Array<{ symbol: string; exDate: string; perShare: number }>;
  dividendCoverageFrom: string | null;
  latestSession: string | null;
}

const symbolList = (symbols: readonly string[]) =>
  symbols.length
    ? sql.join(
        [...new Set(symbols.map((s) => s.toUpperCase()))].map((s) => sql`${s}`),
        sql`, `,
      )
    : sql`null`;

const likeOf = (q: string | null) =>
  q
    ? `%${q
        .toLowerCase()
        .slice(0, 60)
        .replace(/[\\%_]/g, (m) => `\\${m}`)}%`
    : null;

export async function botMarket(
  ctx: AppContext,
  symbols: readonly string[],
  from: string,
): Promise<BotMarket> {
  const key = `prices:bot:${[...symbols].sort().join(",")}:${from}`;
  const out = await ctx.api.getOrLoad(
    key,
    async () => {
      const list = symbolList(symbols);
      const [secs, actions, session] = await Promise.all([
        ctx.db.execute<{
          company_id: number;
          symbol: string;
          name: string;
          sector: string | null;
          industry: string | null;
          market_cap_cr: number | null;
          closes: Array<{ date: string; close: number }> | null;
        }>(sql`
          select c.id as company_id, c.nse_symbol as symbol, c.name, c.sector, c.industry,
                 c.market_cap_cr,
                 (select json_agg(json_build_object('date', p.date::text, 'close', p.close) order by p.date)
                    from prices_daily p
                   where p.company_id = c.id and p.is_final and p.date >= ${from}::date
                     and p.adjustment_generation = coalesce(
                       (select s.adjustment_generation from price_series_state s where s.company_id = c.id),
                       (select max(adjustment_generation) from prices_daily x where x.company_id = c.id))
                 ) as closes
          from companies c where c.nse_symbol in (${list})`),
        ctx.db.execute<{
          symbol: string;
          action_type: string;
          ex_date: string;
          cash_amount: number | null;
          split_numerator: number | null;
          split_denominator: number | null;
        }>(sql`
          select c.nse_symbol as symbol, a.action_type, a.ex_date::text as ex_date, a.cash_amount,
                 a.split_numerator, a.split_denominator
          from corporate_actions a join companies c on c.id = a.company_id
          where c.nse_symbol in (${list}) and a.ex_date >= ${from}::date
          order by a.ex_date`),
        ctx.db.execute<{ latest: string | null; dividends_from: string | null }>(sql`
          select (select max(p.date)::text from index_prices_daily p
                    join indices i on i.id = p.index_id where i.code = 'NIFTY50' and p.is_final) as latest,
                 (select min(ex_date)::text from corporate_actions where action_type = 'dividend') as dividends_from`),
      ]);
      return {
        securities: secs.map((s) => ({
          companyId: Number(s.company_id),
          symbol: s.symbol,
          name: s.name,
          sector: s.sector,
          industry: s.industry,
          marketCapCr: s.market_cap_cr == null ? null : Number(s.market_cap_cr),
          closes: (s.closes ?? []).map((c) => ({ date: c.date, close: Number(c.close) })),
        })),
        splits: actions
          .filter((a) => a.action_type === "split" && a.split_numerator && a.split_denominator)
          .map((a) => ({
            symbol: a.symbol,
            exDate: a.ex_date,
            ratio: Number(a.split_numerator) / Number(a.split_denominator),
          })),
        dividends: actions
          .filter((a) => a.action_type === "dividend" && a.cash_amount != null)
          .map((a) => ({ symbol: a.symbol, exDate: a.ex_date, perShare: Number(a.cash_amount) })),
        dividendCoverageFrom: session[0]?.dividends_from ?? null,
        latestSession: session[0]?.latest ?? null,
      };
    },
    { ttlMs: 15 * MINUTE, staleMs: 2 * HOUR },
  );
  return out as BotMarket;
}

export async function indexLevels(
  ctx: AppContext,
  code: string,
  from: string,
): Promise<Array<{ date: string; close: number }>> {
  const rows = await ctx.api.getOrLoad(
    `prices:bot:index:${code}:${from}`,
    () =>
      ctx.db.execute<{ date: string; close: number }>(sql`
        select p.date::text as date, p.close from index_prices_daily p
        join indices i on i.id = p.index_id
        where i.code = ${code} and p.is_final and p.date >= ${from}::date
        order by p.date`),
    { ttlMs: 15 * MINUTE, staleMs: 2 * HOUR },
  );
  return (rows ?? []).map((r) => ({ date: r.date, close: Number(r.close) }));
}

export interface BotSignal {
  symbol: string;
  kind: string;
  value: number;
  asOf: string;
  modelVersion: number;
  inputs: Record<string, unknown>;
}

const SIGNAL_KINDS = [
  "distress_score",
  "customer_momentum_1m",
  "customer_momentum_3m",
  "supplier_momentum_1m",
  "supplier_momentum_3m",
  "customer_hhi",
  "customer_concentration_pct",
  "top5_customers_pct",
  "top10_customers_pct",
  "travel_legs_7d",
  "travel_counterparty_visit",
  "travel_event_window",
  "travel_operating_site_arrivals_30d",
  "logistics_chokepoint_exposure",
  "logistics_fleet_activity",
  "logistics_arrivals_7d",
];

export async function botSignals(
  ctx: AppContext,
  symbols: readonly string[],
): Promise<BotSignal[]> {
  const rows = await ctx.api.getOrLoad(
    `signals:bot:${[...symbols].sort().join(",")}`,
    () =>
      ctx.db.execute<{
        symbol: string;
        kind: string;
        value: number;
        as_of: string;
        model_version: number;
        inputs: Record<string, unknown> | null;
      }>(sql`
        select distinct on (s.company_id, s.kind) c.nse_symbol as symbol, s.kind, s.value,
               s.as_of::text as as_of, s.model_version, s.inputs
        from signals s join companies c on c.id = s.company_id
        where c.nse_symbol in (${symbolList(symbols)})
          and s.kind in (${sql.join(
            SIGNAL_KINDS.map((k) => sql`${k}`),
            sql`, `,
          )})
          and ${activeSignalVersionClause(sql`s.kind`, sql`s.model_version`)}
        order by s.company_id, s.kind, s.as_of desc, s.model_version desc`),
    { ttlMs: 15 * MINUTE, staleMs: HOUR },
  );
  return (rows ?? []).map((r) => ({
    symbol: r.symbol,
    kind: r.kind,
    value: Number(r.value),
    asOf: r.as_of,
    modelVersion: Number(r.model_version),
    inputs: r.inputs ?? {},
  }));
}

export interface BotLink {
  holding: string;
  side: "customer" | "supplier";
  counterparty: string;
  counterpartySymbol: string | null;
  counterpartyKind: string;
  valueCr: number | null;
  holdingRevenuePct: number | null;
  sharedEstimate: boolean;
  confidence: number;
  lastDisclosedAt: string | null;
  url: string | null;
  quote: string | null;
}

export async function holdingLinks(
  ctx: AppContext,
  symbols: readonly string[],
): Promise<BotLink[]> {
  const rows = await ctx.api.getOrLoad(
    `supply-chain:bot:${[...symbols].sort().join(",")}`,
    () =>
      ctx.db.execute<{
        holding: string;
        side: "customer" | "supplier";
        counterparty: string;
        counterparty_symbol: string | null;
        counterparty_kind: string;
        value_cr: number | null;
        revenue_pct: number | null;
        confidence: number;
        last_disclosed_at: string | null;
        url: string | null;
        quote: string | null;
      }>(sql`
        with h as (
          select c.id, c.nse_symbol from companies c where c.nse_symbol in (${symbolList(symbols)})
        ), e as (
          select h.nse_symbol as holding,
                 case when r.supplier_company_id = h.id then 'customer' else 'supplier' end as side,
                 case when r.supplier_company_id = h.id then r.customer_counterparty_id
                      else r.supplier_counterparty_id end as cp_id,
                 r.id, r.confidence, r.last_disclosed_at,
                 r.supplier_counterparty_id as sup_cp, r.customer_counterparty_id as cus_cp
          from relationships r join h on h.id in (r.supplier_company_id, r.customer_company_id)
          where r.status = 'active' and (r.valid_to is null or r.valid_to >= current_date)
        ), ranked as (
          select e.*, row_number() over (partition by e.holding order by e.confidence desc, e.id) as rn
          from e
        )
        select k.holding, k.side, cp.canonical_name as counterparty, cc.nse_symbol as counterparty_symbol,
               cp.kind as counterparty_kind, est.value_cr, est.supplier_revenue_pct as revenue_pct,
               k.confidence, k.last_disclosed_at::text as last_disclosed_at, ev.url, ev.quote
        from ranked k
        join counterparties cp on cp.id = k.cp_id
        left join companies cc on cc.id = cp.company_id
        left join lateral (
          select x.value_cr, x.supplier_revenue_pct from relationship_estimates x
          where x.relationship_id = k.id and x.value_basis <> 'contract_total'
          order by x.as_of desc, x.model_version desc limit 1
        ) est on true
        left join lateral (
          select d.url, left(sp.quote, 200) as quote
          from relationship_observations o
          join relationship_observation_evidence oe on oe.observation_id = o.id
          join evidence_spans sp on sp.id = oe.evidence_span_id
          join document_revisions dr on dr.id = sp.document_revision_id
          join documents d on d.id = dr.document_id
          where o.supplier_counterparty_id = k.sup_cp and o.customer_counterparty_id = k.cus_cp
            and o.status in ('auto', 'confirmed')
          order by o.id desc limit 1
        ) ev on true
        where k.rn <= 12`),
    { ttlMs: 30 * MINUTE, staleMs: 6 * HOUR },
  );
  const list = rows ?? [];
  const shared = sharedEstimates(
    list.map((r) => ({ group: `${r.holding}|${r.side}`, valueCr: r.value_cr, pct: r.revenue_pct })),
  );
  return list.map((r, i) => ({
    holding: r.holding,
    side: r.side,
    counterparty: r.counterparty,
    counterpartySymbol: r.counterparty_symbol,
    counterpartyKind: r.counterparty_kind,
    valueCr: shared[i] || r.value_cr == null ? null : Number(r.value_cr),
    holdingRevenuePct: shared[i] || r.revenue_pct == null ? null : Number(r.revenue_pct),
    sharedEstimate: shared[i] ?? false,
    confidence: Number(r.confidence),
    lastDisclosedAt: r.last_disclosed_at,
    url: r.url,
    quote: r.quote,
  }));
}

export function sharedEstimates(
  items: ReadonlyArray<{ group: string; valueCr: number | null; pct: number | null }>,
): boolean[] {
  const counts = new Map<string, number>();
  const key = (x: (typeof items)[number]) =>
    x.valueCr == null && x.pct == null ? null : `${x.group}|${x.valueCr}|${x.pct}`;
  for (const x of items) {
    const k = key(x);
    if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return items.map((x) => {
    const k = key(x);
    return k != null && (counts.get(k) ?? 0) > 1;
  });
}

export interface BotFiling {
  id: number;
  symbol: string;
  publishedAt: string;
  subject: string;
  materiality: string | null;
  category: string | null;
  soWhat: string | null;
  url: string | null;
}

export interface BotPolicyEvent {
  id: number;
  title: string;
  ministry: string | null;
  publishedAt: string;
  url: string;
  sectors: string[];
  symbols: string[];
}

export async function filingsFor(
  ctx: AppContext,
  symbols: readonly string[],
  days: number,
  query: string | null,
): Promise<BotFiling[]> {
  const like = likeOf(query);
  const rows = await ctx.api.getOrLoad(
    `announcements:bot:${[...symbols].sort().join(",")}:${days}:${like ?? ""}`,
    () =>
      ctx.db.execute<{
        id: number;
        symbol: string;
        published_at: string;
        subject: string;
        materiality: string | null;
        triage_category: string | null;
        so_what: string | null;
        attachment_url: string | null;
      }>(sql`
        select a.id, c.nse_symbol as symbol, a.published_at::text as published_at, a.subject,
               a.materiality, a.triage_category, a.so_what, a.attachment_url
        from announcements a join companies c on c.id = a.company_id
        where c.nse_symbol in (${symbolList(symbols)})
          and a.published_at >= now() - make_interval(days => ${days})
          and coalesce(a.materiality, 'low') <> 'low'
          ${like ? sql`and (lower(a.subject) like ${like} or lower(coalesce(a.so_what, '')) like ${like} or lower(coalesce(a.details, '')) like ${like})` : sql``}
        order by case a.materiality when 'high' then 0 when 'medium' then 1 else 2 end, a.published_at desc
        limit 40`),
    { ttlMs: 10 * MINUTE, staleMs: HOUR },
  );
  return (rows ?? []).map((r) => ({
    id: Number(r.id),
    symbol: r.symbol,
    publishedAt: r.published_at,
    subject: r.subject,
    materiality: r.materiality,
    category: r.triage_category,
    soWhat: r.so_what,
    url: r.attachment_url,
  }));
}

export async function marketFilings(
  ctx: AppContext,
  days: number,
  query: string | null,
): Promise<BotFiling[]> {
  const like = likeOf(query);
  const rows = await ctx.api.getOrLoad(
    `announcements:bot:market:${days}:${like ?? ""}`,
    () =>
      ctx.db.execute<{
        id: number;
        symbol: string;
        published_at: string;
        subject: string;
        materiality: string | null;
        triage_category: string | null;
        so_what: string | null;
        attachment_url: string | null;
      }>(sql`
        select a.id, c.nse_symbol as symbol, a.published_at::text as published_at, a.subject,
               a.materiality, a.triage_category, a.so_what, a.attachment_url
        from announcements a join companies c on c.id = a.company_id
        where a.published_at >= now() - make_interval(days => ${days})
          and a.materiality in ('high', 'medium')
          ${like ? sql`and (lower(a.subject) like ${like} or lower(coalesce(a.so_what, '')) like ${like})` : sql``}
        order by case a.materiality when 'high' then 0 else 1 end, a.published_at desc
        limit 25`),
    { ttlMs: 10 * MINUTE, staleMs: HOUR },
  );
  return (rows ?? []).map((r) => ({
    id: Number(r.id),
    symbol: r.symbol,
    publishedAt: r.published_at,
    subject: r.subject,
    materiality: r.materiality,
    category: r.triage_category,
    soWhat: r.so_what,
    url: r.attachment_url,
  }));
}

export async function policyEventsFor(
  ctx: AppContext,
  symbols: readonly string[] | null,
  days: number,
  query: string | null,
): Promise<BotPolicyEvent[]> {
  const like = likeOf(query);
  const scope = symbols?.length ? [...symbols].sort().join(",") : "all";
  const rows = await ctx.api.getOrLoad(
    `influence:bot:policy:${scope}:${days}:${like ?? ""}`,
    () =>
      ctx.db.execute<{
        id: number;
        title: string;
        ministry: string | null;
        published_at: string;
        url: string;
        sectors: string[] | null;
        symbols: string[] | null;
      }>(sql`
        with h as (
          select c.id, c.nse_symbol from companies c
          where ${symbols?.length ? sql`c.nse_symbol in (${symbolList(symbols)})` : sql`false`}
        ), hs as (
          select cps.sector_key, h.nse_symbol from company_policy_sectors cps join h on h.id = cps.company_id
        )
        select p.id, p.title, p.ministry, p.published_at::text as published_at, p.url,
               array_remove(array_agg(distinct t.sector_key), null) as sectors,
               array_remove(array_agg(distinct coalesce(hs.nse_symbol, hc.nse_symbol)), null) as symbols
        from policy_events p
        join policy_event_tags t on t.policy_event_id = p.id
        left join hs on hs.sector_key = t.sector_key
        left join h hc on hc.id = t.company_id
        where p.published_at >= now() - make_interval(days => ${days})
          ${like ? sql`and lower(p.title || ' ' || coalesce(p.ministry, '')) like ${like}` : sql``}
        group by p.id
        ${symbols?.length ? sql`having count(hs.nse_symbol) + count(hc.nse_symbol) > 0` : sql``}
        order by p.published_at desc
        limit 25`),
    { ttlMs: 15 * MINUTE, staleMs: HOUR },
  );
  return (rows ?? []).map((r) => ({
    id: Number(r.id),
    title: r.title,
    ministry: r.ministry,
    publishedAt: r.published_at,
    url: r.url,
    sectors: r.sectors ?? [],
    symbols: r.symbols ?? [],
  }));
}

export interface BotCompanyHit {
  symbol: string;
  name: string;
  sector: string | null;
  industry: string | null;
  marketCapCr: number | null;
}

export async function lookupCompanies(ctx: AppContext, q: string): Promise<BotCompanyHit[]> {
  const term = q.trim().toUpperCase().slice(0, 40);
  if (!term) return [];
  const rows = await ctx.api.getOrLoad(
    `company:bot:lookup:${term}`,
    () =>
      ctx.db.execute<{
        symbol: string;
        name: string;
        sector: string | null;
        industry: string | null;
        market_cap_cr: number | null;
      }>(sql`
        select c.nse_symbol as symbol, c.name, c.sector, c.industry, c.market_cap_cr
        from companies c
        where c.nse_symbol is not null
          and (c.nse_symbol = ${term} or c.nse_symbol like ${`${term}%`} or upper(c.name) like ${`%${term}%`}
               or exists (select 1 from company_aliases a where a.company_id = c.id and upper(a.alias) like ${`%${term}%`}))
        order by case when c.nse_symbol = ${term} then 0 when c.nse_symbol like ${`${term}%`} then 1 else 2 end,
                 c.market_cap_cr desc nulls last
        limit 8`),
    { ttlMs: HOUR, staleMs: 6 * HOUR },
  );
  return (rows ?? []).map((r) => ({
    symbol: r.symbol,
    name: r.name,
    sector: r.sector,
    industry: r.industry,
    marketCapCr: r.market_cap_cr == null ? null : Number(r.market_cap_cr),
  }));
}

export async function latestRevenueCr(
  ctx: AppContext,
  symbols: readonly string[],
): Promise<Map<string, number>> {
  if (!symbols.length) return new Map();
  const rows = await ctx.api.getOrLoad(
    `financials:bot:revenue:${[...symbols].sort().join(",")}`,
    () =>
      ctx.db.execute<{ symbol: string; revenue: number }>(sql`
        select distinct on (c.id) c.nse_symbol as symbol, f.revenue
        from fundamentals f join companies c on c.id = f.company_id
        where c.nse_symbol in (${symbolList(symbols)}) and f.period_type = 'annual'
          and f.revenue is not null and f.revenue > 0
        order by c.id, f.period_end desc`),
    { ttlMs: 6 * HOUR, staleMs: 24 * HOUR },
  );
  return new Map((rows ?? []).map((r) => [r.symbol, Number(r.revenue)]));
}

export interface PeerMetrics {
  symbol: string;
  name: string;
  industry: string | null;
  marketCapCr: number | null;
  peLatestFy: number | null;
  roePct: number | null;
  opmPct: number | null;
  revenueGrowthPct: number | null;
  latestFy: string | null;
  self: boolean;
}

export async function industryPeers(
  ctx: AppContext,
  companyId: number,
  limit = 5,
): Promise<PeerMetrics[]> {
  const rows = await ctx.api.getOrLoad(
    `financials:bot:peers:${companyId}:${limit}`,
    () =>
      ctx.db.execute<{
        company_id: number;
        symbol: string;
        name: string;
        industry: string | null;
        market_cap_cr: number | null;
        revenue: number | null;
        prev_revenue: number | null;
        operating_profit: number | null;
        net_income: number | null;
        total_equity: number | null;
        period_end: string | null;
      }>(sql`
        with me as (
          select id, industry, sector, market_cap_cr from companies where id = ${companyId}
        ), pool as (
          select c.* from companies c, me
          where c.nse_symbol is not null and c.id <> me.id and c.market_cap_cr is not null
            and (c.industry = me.industry
              or (not exists (select 1 from companies x where x.industry = me.industry and x.id <> me.id)
                  and c.sector = me.sector))
          order by abs(ln(greatest(c.market_cap_cr, 1)) - ln(greatest(coalesce(me.market_cap_cr, 1), 1)))
          limit ${limit}
        ), chosen as (
          select id from pool union select id from me
        )
        select c.id as company_id, c.nse_symbol as symbol, c.name, c.industry, c.market_cap_cr,
               f.revenue, f.operating_profit, f.net_income, f.total_equity, f.period_end::text,
               (select p.revenue from fundamentals p where p.company_id = c.id and p.period_type = 'annual'
                  and p.period_end < f.period_end and p.revenue is not null
                order by p.period_end desc limit 1) as prev_revenue
        from companies c join chosen ch on ch.id = c.id
        left join lateral (
          select * from fundamentals f where f.company_id = c.id and f.period_type = 'annual'
            and f.revenue is not null and f.net_income is not null
          order by f.period_end desc limit 1
        ) f on true`),
    { ttlMs: 6 * HOUR, staleMs: 24 * HOUR },
  );
  const n = (v: unknown) => (v == null ? null : Number(v));
  const ratio = (a: number | null, b: number | null, k = 1) =>
    a == null || b == null || b <= 0 ? null : (a / b) * k;
  return (rows ?? [])
    .map((r) => {
      const mcap = n(r.market_cap_cr);
      const rev = n(r.revenue);
      const prev = n(r.prev_revenue);
      const ni = n(r.net_income);
      return {
        symbol: r.symbol,
        name: r.name,
        industry: r.industry,
        marketCapCr: mcap,
        peLatestFy: ni != null && ni > 0 ? ratio(mcap, ni) : null,
        roePct: ratio(ni, n(r.total_equity), 100),
        opmPct: ratio(n(r.operating_profit), rev, 100),
        revenueGrowthPct: rev != null && prev != null && prev > 0 ? (rev / prev - 1) * 100 : null,
        latestFy: r.period_end,
        self: Number(r.company_id) === companyId,
      };
    })
    .sort((a, b) => Number(b.self) - Number(a.self) || (b.marketCapCr ?? 0) - (a.marketCapCr ?? 0));
}

export function median(values: Array<number | null>): number | null {
  const v = values
    .filter((x): x is number => x != null && Number.isFinite(x))
    .sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? (v[m] as number) : ((v[m - 1] as number) + (v[m] as number)) / 2;
}
