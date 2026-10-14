import { sleep, throwIfAborted } from "@ma/core";
import { type Db, fencedTransaction, sql } from "@ma/db";
import { ANNOUNCEMENT_POLICY_VERSION, announcementPolicy } from "./policy.js";

export const CLASSIFY_BATCH = 5_000;
export const DELETE_BATCH = 1_000;
export const DELETE_PAUSE_MS = 200;
export const DELETE_STATEMENT_TIMEOUT = "10s";
export const REINDEX_LOCK_TIMEOUT = "30s";
export const VACUUM_CHECK_EVERY = 10;
export const VACUUM_BACKLOG_LIMIT = 2;
const INSUFFICIENT_PRIVILEGE = "42501";
export const EVIDENCE_HOLD = "evidence";
export const ANNOUNCEMENT_DOCUMENT_SOURCES = ["announcement_metadata", "order_filing"] as const;
export const ANNOUNCEMENT_DOCUMENT_PREFIX = "nse://announcement/";

type Fragment = ReturnType<typeof sql>;
type Executor = Pick<Db, "execute" | "transaction">;

export interface IdRange {
  fromId: number;
  toIdExclusive: number;
}

export interface ClassifyResult {
  scanned: number;
  updated: number;
  forever: number;
  fiveYears: number;
  noise: number;
}

export interface DeleteResult {
  held: number;
  noise: number;
  expired: number;
  batches: number;
  complete: boolean;
  vacuumWait: boolean;
}

export interface ReindexResult {
  reindexed: number;
  dropped: number;
  denied: number;
}

const sources = sql.join(
  ANNOUNCEMENT_DOCUMENT_SOURCES.map((s) => sql`${s}`),
  sql`, `,
);

function citedBy(alias: Fragment): Fragment {
  return sql`
    select 1 from documents d
    join document_revisions r on r.document_id = d.id
    join evidence_spans e on e.document_revision_id = r.id
    where d.source in (${sources})
      and (d.url = ${ANNOUNCEMENT_DOCUMENT_PREFIX} || ${alias}.id::text
        or d.url = ${alias}.attachment_url)`;
}

export async function announcementFootprint(
  db: Pick<Db, "execute">,
): Promise<{ rows: number; bytes: number }> {
  const rows = await db.execute<{ rows: number; bytes: number }>(sql`
    select (select count(*) from announcements)::int as rows,
      pg_total_relation_size('announcements')::float8 as bytes`);
  return { rows: Number(rows[0]?.rows ?? 0), bytes: Number(rows[0]?.bytes ?? 0) };
}

export async function announcementMaxId(db: Pick<Db, "execute">): Promise<number> {
  const rows = await db.execute<{ max: number | null }>(
    sql`select max(id)::int as max from announcements`,
  );
  return rows[0]?.max ?? 0;
}

export async function unclassifiedAnnouncements(
  db: Pick<Db, "execute">,
  maxId: number,
): Promise<number> {
  const rows = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from announcements
    where id <= ${maxId} and policy_version < ${ANNOUNCEMENT_POLICY_VERSION}`);
  return rows[0]?.n ?? 0;
}

export async function classifyRanges(
  db: Pick<Db, "execute">,
  maxId: number,
  size = CLASSIFY_BATCH,
): Promise<IdRange[]> {
  const starts = await db.execute<{ id: number }>(sql`
    select id from (
      select id, row_number() over (order by id) as rn from announcements
      where id <= ${maxId} and policy_version < ${ANNOUNCEMENT_POLICY_VERSION}
    ) s
    where (rn - 1) % ${size} = 0
    order by id`);
  return starts.map((s, i) => ({
    fromId: Number(s.id),
    toIdExclusive: Number(starts[i + 1]?.id ?? maxId + 1),
  }));
}

export async function classifyAnnouncementRange(
  db: Executor,
  range: IdRange,
  signal?: AbortSignal,
): Promise<ClassifyResult> {
  const rows = await db.execute<{
    id: number;
    subject: string;
    category: string | null;
    details: string | null;
    publishedMs: number;
  }>(sql`
    select id, subject, category, details,
      (extract(epoch from published_at) * 1000)::float8 as "publishedMs"
    from announcements
    where id >= ${range.fromId} and id < ${range.toIdExclusive}
      and policy_version < ${ANNOUNCEMENT_POLICY_VERSION}
    order by id`);
  const result: ClassifyResult = {
    scanned: rows.length,
    updated: 0,
    forever: 0,
    fiveYears: 0,
    noise: 0,
  };
  if (!rows.length) return result;
  const values = rows.map((r) => {
    const policy = announcementPolicy({
      subject: r.subject,
      category: r.category,
      details: r.details,
      publishedAt: new Date(Number(r.publishedMs)),
    });
    if (policy.retentionClass === "forever") result.forever++;
    else if (policy.retentionClass === "noise") result.noise++;
    else result.fiveYears++;
    return {
      id: Number(r.id),
      category_key: policy.categoryKey,
      retention_class: policy.retentionClass,
      retain_until: policy.retainUntil,
      policy_version: policy.policyVersion,
    };
  });
  const updated = await fencedTransaction(
    db,
    (tx) =>
      tx.execute<{ id: number }>(sql`
        update announcements a set
          category_key = v.category_key,
          retention_class = v.retention_class,
          retain_until = v.retain_until,
          policy_version = v.policy_version
        from jsonb_to_recordset(${JSON.stringify(values)}::jsonb)
          as v(id int, category_key text, retention_class text, retain_until date, policy_version smallint)
        where a.id = v.id and a.policy_version < v.policy_version
        returning a.id`),
    signal,
  );
  result.updated = updated.length;
  return result;
}

export async function holdCitedAnnouncements(
  db: Executor,
  maxId: number,
  signal?: AbortSignal,
): Promise<number> {
  return fencedTransaction(
    db,
    async (tx) => {
      const held = await tx.execute<{ announcement_id: number }>(sql`
        insert into announcement_holds (announcement_id, reason, evidence_span_id)
        select c.announcement_id, ${EVIDENCE_HOLD}, min(c.span_id) from (
          select a.id as announcement_id, e.id as span_id
          from documents d
          join document_revisions r on r.document_id = d.id
          join evidence_spans e on e.document_revision_id = r.id
          join announcements a
            on a.id = substring(d.url from ${`^${ANNOUNCEMENT_DOCUMENT_PREFIX}([0-9]+)$`})::int
          where d.source in (${sources}) and d.url like ${`${ANNOUNCEMENT_DOCUMENT_PREFIX}%`}
            and a.id <= ${maxId}
          union all
          select a.id, e.id
          from documents d
          join document_revisions r on r.document_id = d.id
          join evidence_spans e on e.document_revision_id = r.id
          join announcements a on a.attachment_url = d.url
          where d.source in (${sources}) and a.id <= ${maxId}
        ) c
        group by c.announcement_id
        on conflict (announcement_id, reason) do nothing
        returning announcement_id`);
      await tx.execute(sql`
        update announcements a set retention_class = 'review_hold', retain_until = null
        from announcement_holds h
        where h.announcement_id = a.id and a.retention_class is distinct from 'review_hold'`);
      return held.length;
    },
    signal,
  );
}

export type DeletePhase = "noise" | "expired";

export async function deleteAnnouncementBatch(
  db: Executor,
  phase: DeletePhase,
  maxId: number,
  opts: { limit?: number; signal?: AbortSignal } = {},
): Promise<number> {
  const due =
    phase === "noise"
      ? sql`a.retention_class = 'noise'`
      : sql`a.retention_class in ('noise', 'five_years') and a.retain_until < current_date`;
  return fencedTransaction(
    db,
    async (tx) => {
      await tx.execute(sql.raw(`set local statement_timeout = '${DELETE_STATEMENT_TIMEOUT}'`));
      const rows = await tx.execute<{ id: number }>(sql`
        delete from announcements where id in (
          select a.id from announcements a
          where ${due} and a.id <= ${maxId}
            and not exists (select 1 from announcement_holds h where h.announcement_id = a.id)
            and not exists (${citedBy(sql`a`)})
          order by a.id
          limit ${opts.limit ?? DELETE_BATCH}
          for update skip locked)
        returning id`);
      return rows.length;
    },
    opts.signal,
  );
}

export async function vacuumBacklog(db: Pick<Db, "execute">): Promise<number> {
  const rows = await db.execute<{ ratio: number | null }>(sql`
    select s.n_dead_tup::float8 / nullif(
      current_setting('autovacuum_vacuum_threshold')::float8
        + current_setting('autovacuum_vacuum_scale_factor')::float8 * greatest(c.reltuples, 0),
      0) as ratio
    from pg_stat_user_tables s join pg_class c on c.oid = s.relid
    where s.relid = 'announcements'::regclass`);
  return Number(rows[0]?.ratio ?? 0);
}

export async function deleteExpiredAnnouncements(
  db: Executor,
  opts: {
    maxId: number;
    expired: () => boolean;
    signal?: AbortSignal;
    batch?: number;
    pauseMs?: number;
  },
): Promise<DeleteResult> {
  const batch = opts.batch ?? DELETE_BATCH;
  const result: DeleteResult = {
    held: 0,
    noise: 0,
    expired: 0,
    batches: 0,
    complete: false,
    vacuumWait: false,
  };
  result.held = await holdCitedAnnouncements(db, opts.maxId, opts.signal);
  for (const phase of ["noise", "expired"] as const) {
    for (;;) {
      if (opts.expired()) return result;
      throwIfAborted(opts.signal);
      if (
        result.batches % VACUUM_CHECK_EVERY === 0 &&
        (await vacuumBacklog(db)) > VACUUM_BACKLOG_LIMIT
      ) {
        result.vacuumWait = true;
        return result;
      }
      const n = await deleteAnnouncementBatch(db, phase, opts.maxId, {
        limit: batch,
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      result[phase] += n;
      result.batches++;
      if (n < batch) break;
      await sleep(opts.pauseMs ?? DELETE_PAUSE_MS);
    }
  }
  result.complete = true;
  return result;
}

function sqlState(err: unknown): string | null {
  const code = (err as { code?: unknown })?.code;
  return typeof code === "string" ? code : null;
}

export async function reindexAnnouncements(db: Pick<Db, "$client">): Promise<ReindexResult> {
  const result: ReindexResult = { reindexed: 0, dropped: 0, denied: 0 };
  const conn = await db.$client.reserve();
  const run = async (statement: string, key: "reindexed" | "dropped") => {
    try {
      await conn.unsafe(statement);
      result[key]++;
    } catch (err) {
      if (sqlState(err) !== INSUFFICIENT_PRIVILEGE) throw err;
      result.denied++;
    }
  };
  try {
    await conn.unsafe("set statement_timeout = 0");
    await conn.unsafe(`set lock_timeout = '${REINDEX_LOCK_TIMEOUT}'`);
    const invalid = await conn<{ name: string }[]>`
      select indexrelid::regclass::text as name from pg_index
      where indrelid = 'announcements'::regclass and not indisvalid`;
    for (const { name } of invalid)
      await run(`drop index concurrently if exists ${name}`, "dropped");
    const indexes = await conn<{ name: string }[]>`
      select indexrelid::regclass::text as name from pg_index
      where indrelid = 'announcements'::regclass and indisvalid
      order by indexrelid`;
    for (const { name } of indexes) await run(`reindex index concurrently ${name}`, "reindexed");
  } finally {
    await conn.unsafe("reset all").catch(() => undefined);
    conn.release();
  }
  return result;
}
