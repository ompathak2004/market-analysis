import { AppError, NotFoundError } from "@ma/core";
import { type influenceDecision, sql } from "@ma/db";
import type { AppContext } from "../context";
import { influenceKey } from "./influence";
import {
  clampLimit,
  decodeCursor,
  encodeCursor,
  type ReviewCursor,
  type ReviewEvidence,
} from "./reviews";

export type InfluenceDecision = (typeof influenceDecision.enumValues)[number];

const EVIDENCE_PER_ITEM = 3;
const AFFECTED_DEPTH = 3;
const WALK_KINDS = [
  "director_of",
  "promoter_of",
  "declared_interest",
  "declared_family",
  "owns",
  "related_party",
] as const;

export interface InfluenceReviewNode {
  kind: string;
  label: string;
  symbol: string | null;
}

export interface InfluenceReviewItem {
  edgeId: number;
  version: number;
  kind: string;
  createdAt: string;
  confidence: number;
  from: InfluenceReviewNode;
  to: InfluenceReviewNode;
  detail: string | null;
  validFrom: string | null;
  validTo: string | null;
  evidence: ReviewEvidence[];
}

export interface InfluenceReviewPage {
  items: InfluenceReviewItem[];
  nextCursor: string | null;
}

export interface InfluenceReviewResult {
  reviewId: number;
  status: string;
  version: number;
}

type QueueRow = {
  id: number | string;
  version: number;
  kind: string;
  created_at: string;
  confidence: number;
  from_node: InfluenceReviewNode;
  to_node: InfluenceReviewNode;
  detail: string | null;
  valid_from: string | null;
  valid_to: string | null;
  evidence: ReviewEvidence[] | null;
};

export function influenceReviewQuery(opts: { limit: number; after: ReviewCursor | null }) {
  const after = opts.after
    ? sql`and (e.created_at, e.id) > (${opts.after.createdAt}::timestamptz, ${opts.after.id}::bigint)`
    : sql``;
  return sql`
    select e.id, e.version, e.kind::text as kind,
           to_char(e.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at,
           e.confidence, e.valid_from::text as valid_from, e.valid_to::text as valid_to,
           json_build_object('kind', f.kind, 'label', f.label, 'symbol', f.symbol) as from_node,
           json_build_object('kind', t.kind, 'label', t.label, 'symbol', t.symbol) as to_node,
           coalesce(
             nullif(concat_ws(' · ', replace(pr.office::text, '_', ' '), pr.constituency, pr.party),
                    ''),
             nullif(concat_ws(' · ', replace(ai.kind::text, '_', ' '), ai.description,
                              case when ai.value_cr is null then null
                                   else concat('₹', ai.value_cr::text, ' Cr') end), ''),
             case when pd.id is null then null
                  else concat_ws(' · ', pd.party, concat('₹', pd.amount::text), pd.matched_on) end,
             case when pt.id is null then null
                  else concat_ws(' · ', concat(pt.basis::text, ' tag'), pe.title) end,
             case when rl.id is null then null
                  else concat_ws(' · ', rl.role::text, rl.category) end
           ) as detail,
           ev.evidence
    from influence_edges e
    join graph_node_labels f on f.node_id = e.from_node_id
    join graph_node_labels t on t.node_id = e.to_node_id
    left join political_roles pr on pr.id = e.political_role_id
    left join affidavit_interests ai on ai.id = e.affidavit_interest_id
    left join political_donations pd on pd.id = e.donation_id
    left join policy_event_tags pt on pt.id = e.policy_event_tag_id
    left join policy_events pe on pe.id = pt.policy_event_id
    left join person_roles rl on rl.id = e.person_role_id
    left join lateral (
      select json_agg(json_build_object('quote', x.quote, 'page', x.page,
                                        'documentId', x.document_id, 'source', x.source,
                                        'url', x.url, 'publishedAt', x.published_at)) as evidence
      from (
        select s.quote, s.page, d.id as document_id, d.source, d.url,
               coalesce(dr.published_at, d.published_at) as published_at
        from influence_edge_evidence ee
        join evidence_spans s on s.id = ee.evidence_span_id
        join document_revisions dr on dr.id = s.document_revision_id
        join documents d on d.id = dr.document_id
        where ee.edge_id = e.id
        order by s.id
        limit ${EVIDENCE_PER_ITEM}
      ) x
    ) ev on true
    where e.status = 'pending'
      ${after}
    order by e.created_at, e.id
    limit ${opts.limit + 1}`;
}

function itemFrom(r: QueueRow): InfluenceReviewItem {
  return {
    edgeId: Number(r.id),
    version: Number(r.version),
    kind: r.kind,
    createdAt: r.created_at,
    confidence: Number(r.confidence),
    from: r.from_node,
    to: r.to_node,
    detail: r.detail ?? null,
    validFrom: r.valid_from ?? null,
    validTo: r.valid_to ?? null,
    evidence: r.evidence ?? [],
  };
}

export async function influenceReviewQueue(
  ctx: AppContext,
  opts: { limit?: number | null; cursor?: string | null } = {},
): Promise<InfluenceReviewPage> {
  const limit = clampLimit(opts.limit);
  const after = opts.cursor ? decodeCursor(opts.cursor) : null;
  if (opts.cursor && !after) throw new AppError("invalid cursor", "BAD_REQUEST", 400);
  const rows = [...(await ctx.db.execute<QueueRow>(influenceReviewQuery({ limit, after })))];
  const page = rows.slice(0, limit).map(itemFrom);
  const last = page.at(-1);
  return {
    items: page,
    nextCursor:
      rows.length > limit && last
        ? encodeCursor({ createdAt: last.createdAt, id: last.edgeId })
        : null,
  };
}

function pgError(err: unknown): { code: string; message: string } | null {
  for (let e: unknown = err, depth = 0; e && depth < 4; depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) {
      const message = (e as { message?: unknown }).message;
      return { code, message: typeof message === "string" ? message : code };
    }
    e = (e as { cause?: unknown }).cause;
  }
  return null;
}

export async function reviewInfluenceEdge(
  ctx: AppContext,
  input: { edgeId: number; decision: InfluenceDecision; version: number; note?: string | null },
  reviewer: string,
): Promise<InfluenceReviewResult> {
  const note = input.note?.trim() || null;
  const result = await ctx.db
    .transaction(
      async (tx) => {
        const [row] = await tx.execute<{ review_id: number; status: string; version: number }>(sql`
          select * from review_influence_edge(${input.edgeId}::bigint, ${input.decision},
            ${reviewer}, ${note}, ${input.version}::integer)`);
        const companies = await tx.execute<{ company_id: number }>(sql`
          with recursive walk(node_id, depth) as (
            select unnest(array[e.from_node_id, e.to_node_id]), 0
            from influence_edges e where e.id = ${input.edgeId}
            union
            select case when x.from_node_id = w.node_id then x.to_node_id else x.from_node_id end,
                   w.depth + 1
            from walk w
            join influence_edges x on x.from_node_id = w.node_id or x.to_node_id = w.node_id
            where w.depth < ${AFFECTED_DEPTH} and x.status = 'confirmed'
              and x.kind::text in (${sql.join(
                WALK_KINDS.map((k) => sql`${k}`),
                sql`, `,
              )})
          ),
          nodes as (
            select node_id from walk
            union
            select x.from_node_id from walk w
            join influence_edges x on x.to_node_id = w.node_id
            where w.depth = 0 and x.kind = 'operates_in_sector' and x.status = 'confirmed'
          )
          select distinct l.company_id from nodes n
          join graph_node_labels l on l.node_id = n.node_id
          where l.company_id is not null`);
        return { row, companyIds: companies.map((c) => Number(c.company_id)) };
      },
      { accessMode: "read write" },
    )
    .catch((err: unknown) => {
      const pg = pgError(err);
      if (pg?.code === "P0002") throw new NotFoundError("influence edge", String(input.edgeId));
      if (pg?.code === "22023") throw new AppError(pg.message, "BAD_REQUEST", 400);
      if (pg?.code === "40001") throw new AppError(pg.message, "CONFLICT", 409);
      throw err;
    });
  if (!result.row) throw new NotFoundError("influence edge", String(input.edgeId));
  await Promise.all(
    result.companyIds.map((id) =>
      ctx.api
        .invalidatePrefix(influenceKey(id))
        .catch((err: unknown) =>
          ctx.logger.warn({ err, companyId: id }, "influence invalidation failed"),
        ),
    ),
  );
  return {
    reviewId: Number(result.row.review_id),
    status: result.row.status,
    version: Number(result.row.version),
  };
}
