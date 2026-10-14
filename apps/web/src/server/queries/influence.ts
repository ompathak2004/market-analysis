import { NotFoundError } from "@ma/core";
import { sql } from "@ma/db";
import type { AppContext } from "../context";
import { findCompany } from "./core";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const EVENT_LIMIT = 40;
const POLICY_LIMIT = 20;
const EVIDENCE_PER_EDGE = 3;

const POLITICAL_KINDS = [
  "holds_office",
  "declared_interest",
  "declared_family",
  "member_of_party",
  "donated_to",
] as const;

const ROLE_ORDER = [
  "chairman",
  "md",
  "ceo",
  "cfo",
  "independent_director",
  "director",
  "kmp",
  "promoter",
  "other",
] as const;

export type InfluenceRole = (typeof ROLE_ORDER)[number];

export interface InfluenceEvidence {
  spanId: number;
  quote: string;
  page: number | null;
  documentId: number;
  source: string;
  url: string;
  publishedAt: string | null;
}

export interface InfluenceDirector {
  edgeId: number;
  personId: number;
  name: string;
  din: string | null;
  role: InfluenceRole | null;
  category: string | null;
  status: "current" | "past";
  validFrom: string | null;
  validTo: string | null;
  confidence: number;
  evidence: InfluenceEvidence[];
}

export interface InfluenceEntity {
  edgeId: number;
  kind: "promoter_of" | "related_party" | "owns";
  nodeKind: "person" | "company" | "counterparty";
  name: string;
  symbol: string | null;
  counterpartyKind: string | null;
  relationship: string | null;
  transactionType: string | null;
  valueCr: number | null;
  totalCr: number | null;
  transactions: number;
  periodStart: string | null;
  periodEnd: string | null;
  pct: number | null;
  asOf: string | null;
  confidence: number;
  evidence: InfluenceEvidence[];
}

export interface InfluencePoliticalLink {
  edgeId: number;
  kind: (typeof POLITICAL_KINDS)[number];
  from: string;
  to: string;
  toKind: string;
  validFrom: string | null;
  validTo: string | null;
  confidence: number;
  evidence: InfluenceEvidence[];
}

export interface InfluencePolicyEvent {
  edgeId: number;
  policyEventId: number;
  source: string;
  title: string;
  ministry: string | null;
  stage: string | null;
  publishedAt: string;
  url: string;
  target: string;
  confidence: number;
  evidence: InfluenceEvidence[];
}

export type InfluenceEvent = {
  id: number;
  kind: string;
  occurredAt: string;
  summary: string;
  reviewed: boolean;
};

export interface InfluenceCoverage {
  governanceReadAt: string | null;
  rptReadAt: string | null;
  perimeterReadAt: string | null;
  resolverVersion: number | null;
  confirmed: number;
  pending: number;
  pendingByKind: { kind: string; count: number }[];
  directorsListed: number;
  rptRows: number;
  rptPeriodEnd: string | null;
}

export interface InfluenceResponse {
  schemaVersion: 1;
  company: { id: number; symbol: string };
  board: InfluenceDirector[];
  promoters: InfluenceEntity[];
  related: InfluenceEntity[];
  political: InfluencePoliticalLink[];
  policy: InfluencePolicyEvent[];
  events: InfluenceEvent[];
  coverage: InfluenceCoverage;
}

type GraphRow = {
  board: InfluenceDirector[] | null;
  promoters: InfluenceEntity[] | null;
  related: InfluenceEntity[] | null;
  political: InfluencePoliticalLink[] | null;
  policy: InfluencePolicyEvent[] | null;
};

type CoverageRow = {
  coverage: Omit<InfluenceCoverage, "pendingByKind"> & {
    pendingByKind: InfluenceCoverage["pendingByKind"] | null;
  };
};

const pgArray = (items: readonly string[]) =>
  sql`array[${sql.join(
    items.map((i) => sql`${i}`),
    sql`, `,
  )}]::text[]`;

export function influenceKey(companyId: number): string {
  return `influence:${companyId}:`;
}

export async function influenceFor(ctx: AppContext, symbol: string): Promise<InfluenceResponse> {
  const company = await findCompany(ctx, symbol);
  const data = await ctx.api.getOrLoad(
    `${influenceKey(company.id)}v1`,
    async () => {
      const today = new Date().toISOString().slice(0, 10);
      const [graph, events, coverage] = await Promise.all([
        ctx.db.execute<GraphRow>(sql`
          with node as (
            select id from graph_nodes where company_id = ${company.id}
          ), own as (
            select e.* from influence_edges_confirmed e, node
            where (e.kind in ('director_of', 'promoter_of') and e.to_node_id = node.id)
               or (e.kind in ('related_party', 'owns') and e.from_node_id = node.id)
          ), board_nodes as (
            select from_node_id from own
            where kind = 'director_of' and (valid_to is null or valid_to >= ${today}::date)
          ), political as (
            select e.* from influence_edges_confirmed e, node
            where e.kind::text = any(${pgArray(POLITICAL_KINDS)})
              and (e.from_node_id = node.id or e.to_node_id = node.id
                or e.from_node_id in (select from_node_id from board_nodes))
          ), sectors as (
            select e.to_node_id from influence_edges_confirmed e, node
            where e.kind = 'operates_in_sector' and e.from_node_id = node.id
          ), policy as (
            select e.*, pe.id as policy_event_id, pe.source::text as policy_source, pe.title,
                   pe.ministry, pe.stage, pe.published_at, pe.url as policy_url
            from influence_edges_confirmed e
            join graph_nodes pn on pn.id = e.from_node_id
            join policy_events pe on pe.id = pn.policy_event_id
            cross join node
            where e.kind = 'policy_applies_to'
              and (e.to_node_id = node.id or e.to_node_id in (select to_node_id from sectors))
          ), cited as (
            select id from own union select id from political union select id from policy
          ), evidence as (
            select x.edge_id,
                   json_agg(json_build_object(
                     'spanId', x.span_id, 'quote', x.quote, 'page', x.page,
                     'documentId', x.document_id, 'source', x.source, 'url', x.url,
                     'publishedAt', x.published_at) order by x.ord) as items
            from (
              select ee.edge_id, s.id as span_id, s.quote, s.page, d.id as document_id, d.source,
                     d.url, coalesce(dr.published_at, d.published_at) as published_at,
                     row_number() over (
                       partition by ee.edge_id
                       order by coalesce(dr.published_at, d.published_at) desc nulls last, s.id desc
                     ) as ord
              from influence_edge_evidence ee
              join cited c on c.id = ee.edge_id
              join evidence_spans s on s.id = ee.evidence_span_id
              join document_revisions dr on dr.id = s.document_revision_id
              join documents d on d.id = dr.document_id
            ) x
            where x.ord <= ${EVIDENCE_PER_EDGE}
            group by x.edge_id
          ), entities as (
            select e.id, e.kind,
                   case when e.kind = 'promoter_of' then e.from_kind else e.to_kind end as node_kind,
                   case when e.kind = 'promoter_of' then e.from_label else e.to_label end as name,
                   case when e.kind = 'promoter_of' then e.from_symbol else e.to_symbol end as symbol,
                   case when e.kind = 'promoter_of' then e.from_counterparty_kind
                        else e.to_counterparty_kind end as counterparty_kind,
                   r.relationship, r.transaction_type, r.value_cr, r.period_start, r.period_end,
                   r.counterparty_name, o.pct, o.as_of, e.confidence, v.items
            from own e
            left join related_party_transactions r on r.id = e.rpt_id
            left join ownership o on o.id = e.ownership_id
            left join evidence v on v.edge_id = e.id
            where e.kind in ('promoter_of', 'related_party', 'owns')
          ), entity_json as (
            select n.kind, n.value_cr, n.id,
                   json_build_object(
                     'edgeId', n.id, 'kind', n.kind, 'nodeKind', n.node_kind, 'name', n.name,
                     'symbol', n.symbol, 'counterpartyKind', n.counterparty_kind,
                     'relationship', n.relationship, 'transactionType', n.transaction_type,
                     'valueCr', n.value_cr, 'totalCr', coalesce(t.total_cr, n.value_cr),
                     'transactions', coalesce(t.n, case when n.value_cr is null then 0 else 1 end),
                     'periodStart', n.period_start, 'periodEnd', n.period_end,
                     'pct', n.pct, 'asOf', n.as_of, 'confidence', n.confidence,
                     'evidence', coalesce(n.items, '[]'::json)) as j,
                   coalesce(t.total_cr, n.value_cr) as total_cr
            from entities n
            left join lateral (
              select sum(x.value_cr) as total_cr, count(*)::int as n
              from related_party_transactions x
              where x.company_id = ${company.id} and x.period_end = n.period_end
                and x.counterparty_name = n.counterparty_name
            ) t on n.counterparty_name is not null
          )
          select
            (select json_agg(json_build_object(
                      'edgeId', e.id, 'personId', e.from_person_id, 'name', e.from_label,
                      'din', e.from_din, 'role', pr.role, 'category', pr.category,
                      'status', case when e.valid_to is not null and e.valid_to < ${today}::date
                                     then 'past' else coalesce(pr.status::text, 'current') end,
                      'validFrom', e.valid_from, 'validTo', e.valid_to,
                      'confidence', e.confidence, 'evidence', coalesce(v.items, '[]'::json))
                    order by (e.valid_to is null or e.valid_to >= ${today}::date) desc,
                             array_position(${pgArray(ROLE_ORDER)}, pr.role::text) nulls last,
                             e.from_label)
             from own e
             left join person_roles pr on pr.id = e.person_role_id
             left join evidence v on v.edge_id = e.id
             where e.kind = 'director_of' and e.from_kind = 'person') as board,
            (select json_agg(j order by pct_rank desc nulls last, id)
             from (select j, id, (j->>'pct')::real as pct_rank from entity_json
                   where kind = 'promoter_of') p) as promoters,
            (select json_agg(j order by total_cr desc nulls last, id)
             from entity_json where kind in ('related_party', 'owns')) as related,
            (select json_agg(json_build_object(
                      'edgeId', e.id, 'kind', e.kind, 'from', e.from_label, 'to', e.to_label,
                      'toKind', e.to_kind, 'validFrom', e.valid_from, 'validTo', e.valid_to,
                      'confidence', e.confidence, 'evidence', coalesce(v.items, '[]'::json))
                    order by e.updated_at desc)
             from political e
             left join evidence v on v.edge_id = e.id) as political,
            (select json_agg(row_json order by published_at desc)
             from (
               select json_build_object(
                        'edgeId', e.id, 'policyEventId', e.policy_event_id,
                        'source', e.policy_source, 'title', e.title, 'ministry', e.ministry,
                        'stage', e.stage, 'publishedAt', e.published_at, 'url', e.policy_url,
                        'target', e.to_label, 'confidence', e.confidence,
                        'evidence', coalesce(v.items, '[]'::json)) as row_json,
                      e.published_at
               from policy e
               left join evidence v on v.edge_id = e.id
               order by e.published_at desc
               limit ${POLICY_LIMIT}
             ) p) as policy`),
        ctx.db.execute<InfluenceEvent>(sql`
          select ev.id, ev.kind::text as kind, ev.occurred_at::text as "occurredAt", ev.summary,
                 not exists (
                   select 1 from influence_event_edges ee
                   join influence_edges e on e.id = ee.edge_id
                   where ee.event_id = ev.id and e.status <> 'confirmed'
                 ) as reviewed
          from influence_events ev
          where ev.company_id = ${company.id}
          order by ev.occurred_at desc, ev.id desc
          limit ${EVENT_LIMIT}`),
        ctx.db.execute<CoverageRow>(sql`
          with node as (
            select id from graph_nodes where company_id = ${company.id}
          ), counts as (
            select e.kind::text as kind, e.status::text as status, count(*)::int as n
            from influence_edges e, node
            where (e.from_node_id = node.id or e.to_node_id = node.id)
              and e.status in ('pending', 'confirmed')
            group by 1, 2
          ), rpt as (
            select max(period_end) as period_end from related_party_transactions
            where company_id = ${company.id} and source = 'nse_rpt'
          )
          select json_build_object(
                   'governanceReadAt', c.governance_read_at,
                   'rptReadAt', c.rpt_read_at,
                   'perimeterReadAt', c.perimeter_read_at,
                   'resolverVersion', c.resolver_version,
                   'confirmed', coalesce((select sum(n) from counts where status = 'confirmed'), 0),
                   'pending', coalesce((select sum(n) from counts where status = 'pending'), 0),
                   'pendingByKind', (select json_agg(json_build_object('kind', kind, 'count', n)
                                                     order by n desc, kind)
                                     from counts where status = 'pending'),
                   'directorsListed', (select count(*)::int from person_roles
                                       where company_id = ${company.id} and status = 'current'),
                   'rptRows', (select count(*)::int from related_party_transactions t, rpt
                               where t.company_id = ${company.id} and t.source = 'nse_rpt'
                                 and t.period_end = rpt.period_end),
                   'rptPeriodEnd', (select period_end from rpt)) as coverage
          from (select 1) one
          left join influence_coverage c on c.company_id = ${company.id}`),
      ]);
      const g = graph[0];
      const c = coverage[0]?.coverage;
      return {
        schemaVersion: 1 as const,
        company: { id: company.id, symbol: company.nseSymbol ?? symbol.toUpperCase() },
        board: g?.board ?? [],
        promoters: g?.promoters ?? [],
        related: g?.related ?? [],
        political: g?.political ?? [],
        policy: g?.policy ?? [],
        events: [...events].map((e) => ({ ...e, id: Number(e.id) })),
        coverage: {
          governanceReadAt: c?.governanceReadAt ?? null,
          rptReadAt: c?.rptReadAt ?? null,
          perimeterReadAt: c?.perimeterReadAt ?? null,
          resolverVersion: c?.resolverVersion ?? null,
          confirmed: Number(c?.confirmed ?? 0),
          pending: Number(c?.pending ?? 0),
          pendingByKind: c?.pendingByKind ?? [],
          directorsListed: Number(c?.directorsListed ?? 0),
          rptRows: Number(c?.rptRows ?? 0),
          rptPeriodEnd: c?.rptPeriodEnd ?? null,
        },
      };
    },
    { ttlMs: 30 * MINUTE, staleMs: 6 * HOUR },
  );
  if (!data) throw new NotFoundError("influence", company.nseSymbol ?? symbol);
  return data;
}
