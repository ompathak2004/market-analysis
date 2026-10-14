import { AppError, NotFoundError } from "@ma/core";
import { type relationshipObservations, type reviewDecision, sql } from "@ma/db";
import type { AppContext } from "../context";
import { type CostBucket, type Counterparty, supplyChainKey, type ValueBasis } from "./core";

type Observation = typeof relationshipObservations.$inferSelect;
type SQL = ReturnType<typeof sql>;

export type ReviewDecision = (typeof reviewDecision.enumValues)[number];

export const REVIEW_CONFIDENCE_THRESHOLD = 0.8;
export const REVIEW_PAGE_DEFAULT = 50;
export const REVIEW_PAGE_MAX = 100;

export interface ReviewCursor {
  createdAt: string;
  id: number;
}

export interface ReviewEvidence {
  quote: string;
  page: number | null;
  documentId: number;
  source: string;
  url: string;
  publishedAt: string | null;
}

export interface ReviewQueueItem {
  observationId: number;
  createdAt: string;
  focal: { id: number; symbol: string | null; name: string };
  supplier: Counterparty;
  customer: Counterparty;
  claim: string;
  cueClass: string | null;
  pct: number | null;
  valueCr: number | null;
  currency: string | null;
  valueBasis: ValueBasis;
  costBucket: CostBucket;
  disclosedBy: Observation["disclosedBy"];
  disclosureKind: Observation["disclosureKind"];
  orderStatus: Observation["orderStatus"];
  period: { start: string | null; end: string | null; fiscalYear: number | null };
  confidence: number;
  newCounterparty: boolean;
  extractorFamily: string;
  evidence: ReviewEvidence | null;
}

export interface ReviewQueuePage {
  items: ReviewQueueItem[];
  nextCursor: string | null;
}

export interface ReviewResult {
  reviewId: number;
  observationStatus: Observation["status"];
  relationshipId: number | null;
}

const CURSOR_SHAPE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z)\|([1-9]\d{0,17})$/;

export function encodeCursor(c: ReviewCursor): string {
  return Buffer.from(`${c.createdAt}|${c.id}`, "utf8").toString("base64url");
}

export function decodeCursor(raw: string | null | undefined): ReviewCursor | null {
  if (!raw || raw.length > 96 || !/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  const m = CURSOR_SHAPE.exec(Buffer.from(raw, "base64url").toString("utf8"));
  if (!m?.[1] || !m[2] || Number.isNaN(Date.parse(m[1]))) return null;
  const id = Number(m[2]);
  return Number.isSafeInteger(id) ? { createdAt: m[1], id } : null;
}

export function clampLimit(limit: number | null | undefined): number {
  if (limit == null || !Number.isFinite(limit)) return REVIEW_PAGE_DEFAULT;
  return Math.max(1, Math.min(REVIEW_PAGE_MAX, Math.trunc(limit)));
}

export interface ReviewItemsFilter {
  join?: SQL;
  where: SQL;
  orderBy: SQL;
  limit: number;
}

export function reviewItemsQuery(filter: ReviewItemsFilter) {
  return sql`
    select o.id,
           to_char(o.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at,
           json_build_object('id', f.id, 'symbol', f.nse_symbol, 'name', f.name) as focal,
           json_build_object('id', sc.id, 'kind', sc.kind, 'name', sc.canonical_name,
                             'symbol', sco.nse_symbol) as supplier,
           json_build_object('id', cc.id, 'kind', cc.kind, 'name', cc.canonical_name,
                             'symbol', cco.nse_symbol) as customer,
           o.claim, o.cue_class, o.pct, o.value_cr::text as value_cr, o.currency, o.value_basis,
           o.cost_bucket, o.disclosed_by, o.disclosure_kind, o.order_status,
           o.period_start::text as period_start, o.period_end::text as period_end,
           o.fiscal_year, o.confidence, o.new_counterparty, ex.extractor_family,
           ev.evidence
    from relationship_observations o
    ${filter.join ?? sql``}
    join relationship_extractions ex on ex.id = o.extraction_id
    join companies f on f.id = o.focal_company_id
    join counterparties sc on sc.id = o.supplier_counterparty_id
    left join companies sco on sco.id = sc.company_id
    join counterparties cc on cc.id = o.customer_counterparty_id
    left join companies cco on cco.id = cc.company_id
    left join lateral (
      select json_build_object('quote', s.quote, 'page', s.page, 'documentId', d.id,
                               'source', d.source, 'url', d.url,
                               'publishedAt', coalesce(dr.published_at, d.published_at)) as evidence
      from relationship_observation_evidence oe
      join evidence_spans s on s.id = oe.evidence_span_id
      join document_revisions dr on dr.id = s.document_revision_id
      join documents d on d.id = dr.document_id
      where oe.observation_id = o.id
      order by s.id
      limit 1
    ) ev on true
    where ${filter.where}
    order by ${filter.orderBy}
    limit ${filter.limit + 1}`;
}

export function reviewQueueQuery(opts: { limit: number; after: ReviewCursor | null }) {
  const after = opts.after
    ? sql`and (o.created_at, o.id) > (${opts.after.createdAt}::timestamptz, ${opts.after.id}::bigint)`
    : sql``;
  return reviewItemsQuery({
    where: sql`o.status = 'pending'
      and (o.confidence < ${REVIEW_CONFIDENCE_THRESHOLD} or o.new_counterparty)
      ${after}`,
    orderBy: sql`o.created_at, o.id`,
    limit: opts.limit,
  });
}

type QueueRow = {
  id: number | string;
  created_at: string;
  focal: ReviewQueueItem["focal"];
  supplier: Counterparty;
  customer: Counterparty;
  claim: string;
  cue_class: string | null;
  pct: number | null;
  value_cr: string | null;
  currency: string | null;
  value_basis: ValueBasis;
  cost_bucket: CostBucket;
  disclosed_by: Observation["disclosedBy"];
  disclosure_kind: Observation["disclosureKind"];
  order_status: Observation["orderStatus"];
  period_start: string | null;
  period_end: string | null;
  fiscal_year: number | null;
  confidence: number;
  new_counterparty: boolean;
  extractor_family: string;
  evidence: ReviewEvidence | null;
};

function itemFrom(r: QueueRow): ReviewQueueItem {
  return {
    observationId: Number(r.id),
    createdAt: r.created_at,
    focal: r.focal,
    supplier: r.supplier,
    customer: r.customer,
    claim: r.claim,
    cueClass: r.cue_class ?? null,
    pct: r.pct == null ? null : Number(r.pct),
    valueCr: r.value_cr == null ? null : Number(r.value_cr),
    currency: r.currency ?? null,
    valueBasis: r.value_basis,
    costBucket: r.cost_bucket,
    disclosedBy: r.disclosed_by,
    disclosureKind: r.disclosure_kind,
    orderStatus: r.order_status ?? null,
    period: { start: r.period_start, end: r.period_end, fiscalYear: r.fiscal_year ?? null },
    confidence: Number(r.confidence),
    newCounterparty: Boolean(r.new_counterparty),
    extractorFamily: r.extractor_family,
    evidence: r.evidence ?? null,
  };
}

export async function reviewItems(
  ctx: AppContext,
  query: SQL,
  limit: number,
): Promise<{ items: ReviewQueueItem[]; more: boolean }> {
  const rows = [...(await ctx.db.execute<QueueRow>(query))];
  return { items: rows.slice(0, limit).map(itemFrom), more: rows.length > limit };
}

export async function reviewQueue(
  ctx: AppContext,
  opts: { limit?: number | null; cursor?: string | null } = {},
): Promise<ReviewQueuePage> {
  const limit = clampLimit(opts.limit);
  const after = opts.cursor ? decodeCursor(opts.cursor) : null;
  if (opts.cursor && !after) throw new AppError("invalid cursor", "BAD_REQUEST", 400);
  const { items, more } = await reviewItems(ctx, reviewQueueQuery({ limit, after }), limit);
  const last = items.at(-1);
  return {
    items,
    nextCursor:
      more && last ? encodeCursor({ createdAt: last.createdAt, id: last.observationId }) : null,
  };
}

export function pgError(err: unknown): { code: string; message: string } | null {
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

export async function reviewRelationship(
  ctx: AppContext,
  input: { observationId: number; decision: ReviewDecision; note?: string | null },
  reviewer: string,
): Promise<ReviewResult> {
  const note = input.note?.trim() || null;
  const result = await ctx.db
    .transaction(
      async (tx) => {
        const [row] = await tx.execute<{
          review_id: number;
          observation_status: Observation["status"];
          relationship_id: number | null;
        }>(sql`
          select * from review_relationship(${input.observationId}::bigint,
            ${input.decision}::review_decision, ${reviewer}, ${note})`);
        const companies = await tx.execute<{ company_id: number }>(sql`
          select distinct x.company_id from relationship_observations o
          left join counterparties sc on sc.id = o.supplier_counterparty_id
          left join counterparties cc on cc.id = o.customer_counterparty_id
          cross join lateral (values (o.focal_company_id), (sc.company_id), (cc.company_id))
            as x(company_id)
          where o.id = ${input.observationId} and x.company_id is not null`);
        return { row, companyIds: companies.map((c) => Number(c.company_id)) };
      },
      { accessMode: "read write" },
    )
    .catch((err: unknown) => {
      const code = pgError(err)?.code;
      if (code === "P0002") throw new NotFoundError("observation", String(input.observationId));
      if (code === "22023") throw new AppError("reviewer required", "BAD_REQUEST", 400);
      throw err;
    });
  if (!result.row) throw new NotFoundError("observation", String(input.observationId));
  await Promise.all(
    result.companyIds.map((id) =>
      ctx.api
        .invalidatePrefix(supplyChainKey(id))
        .catch((err: unknown) =>
          ctx.logger.warn({ err, companyId: id }, "supply-chain invalidation failed"),
        ),
    ),
  );
  return {
    reviewId: Number(result.row.review_id),
    observationStatus: result.row.observation_status,
    relationshipId: result.row.relationship_id == null ? null : Number(result.row.relationship_id),
  };
}
