import { AppError, NotFoundError } from "@ma/core";
import { sql } from "@ma/db";
import type { AppContext } from "../context";
import { clampLimit, type ReviewQueuePage, reviewItems, reviewItemsQuery } from "./reviews";

export const PRECISION_GATE = 0.9;
const WILSON_Z = 1.96;

export interface PrecisionSummary {
  sample: {
    id: number;
    name: string;
    family: string | null;
    size: number;
    seed: string;
    createdAt: string;
  };
  counts: {
    items: number;
    reviewed: number;
    confirmed: number;
    rejected: number;
    blocked: number;
    unreviewed: number;
  };
  precision: number | null;
  lowerBound: number;
  gate: number;
  passes: boolean;
}

export function wilsonLowerBound(successes: number, n: number): number {
  if (n <= 0) return 0;
  const p = successes / n;
  const z2 = WILSON_Z * WILSON_Z;
  const centre = p + z2 / (2 * n);
  const margin = WILSON_Z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return Math.max(0, (centre - margin) / (1 + z2 / n));
}

const DECISION = sql`coalesce(
  (select rv.decision::text from relationship_reviews rv
   where rv.observation_id = o.id order by rv.id desc limit 1),
  case o.status when 'confirmed' then 'confirm' when 'rejected' then 'reject'
                when 'blocked' then 'block' end)`;

type SummaryRow = {
  id: number;
  name: string;
  extractor_family: string | null;
  size: number;
  seed: string;
  created_at: string;
  items: number;
  confirmed: number;
  rejected: number;
  blocked: number;
};

export async function precisionSummary(ctx: AppContext, name: string): Promise<PrecisionSummary> {
  const [row] = await ctx.db.execute<SummaryRow>(sql`
    select ps.id, ps.name, ps.extractor_family, ps.size, ps.seed,
           to_char(ps.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at,
           count(d.observation_id)::int as items,
           (count(*) filter (where d.decision = 'confirm'))::int as confirmed,
           (count(*) filter (where d.decision = 'reject'))::int as rejected,
           (count(*) filter (where d.decision = 'block'))::int as blocked
    from relationship_precision_samples ps
    left join lateral (
      select psi.observation_id, ${DECISION} as decision
      from relationship_precision_sample_items psi
      join relationship_observations o on o.id = psi.observation_id
      where psi.sample_id = ps.id
    ) d on true
    where ps.name = ${name}
    group by ps.id`);
  if (!row) throw new NotFoundError("precision sample", name);
  const confirmed = Number(row.confirmed);
  const rejected = Number(row.rejected);
  const blocked = Number(row.blocked);
  const items = Number(row.items);
  const size = Number(row.size);
  const reviewed = confirmed + rejected + blocked;
  const lowerBound = wilsonLowerBound(confirmed, reviewed);
  return {
    sample: {
      id: Number(row.id),
      name: row.name,
      family: row.extractor_family,
      size,
      seed: row.seed,
      createdAt: row.created_at,
    },
    counts: { items, reviewed, confirmed, rejected, blocked, unreviewed: items - reviewed },
    precision: reviewed ? confirmed / reviewed : null,
    lowerBound,
    gate: PRECISION_GATE,
    passes: reviewed === size && lowerBound >= PRECISION_GATE,
  };
}

const SAMPLE_CURSOR = /^[1-9]\d{0,17}$/;

export function decodeSampleCursor(raw: string | null | undefined): number | null {
  if (!raw || !SAMPLE_CURSOR.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : null;
}

export async function sampleQueue(
  ctx: AppContext,
  opts: { name: string; limit?: number | null; cursor?: string | null },
): Promise<ReviewQueuePage> {
  const limit = clampLimit(opts.limit);
  const after = opts.cursor ? decodeSampleCursor(opts.cursor) : null;
  if (opts.cursor && after == null) throw new AppError("invalid cursor", "BAD_REQUEST", 400);
  const keyset =
    after == null
      ? sql``
      : sql`and psi.position > (select a.position from relationship_precision_sample_items a
                                where a.sample_id = ps.id and a.observation_id = ${after})`;
  const { items, more } = await reviewItems(
    ctx,
    reviewItemsQuery({
      join: sql`join relationship_precision_sample_items psi on psi.observation_id = o.id
        join relationship_precision_samples ps on ps.id = psi.sample_id`,
      where: sql`ps.name = ${opts.name} and ${DECISION} is null ${keyset}`,
      orderBy: sql`psi.position`,
      limit,
    }),
    limit,
  );
  const last = items.at(-1);
  return { items, nextCursor: more && last ? String(last.observationId) : null };
}
