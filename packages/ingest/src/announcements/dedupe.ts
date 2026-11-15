import { sha256, sleep, throwIfAborted } from "@ma/core";
import { type Db, fencedTransaction, sql } from "@ma/db";
import {
  ANNOUNCEMENT_DOCUMENT_PREFIX,
  ANNOUNCEMENT_DOCUMENT_SOURCES,
  ANNOUNCEMENT_EVIDENCE_LOCK,
  DELETE_PAUSE_MS,
  DELETE_STATEMENT_TIMEOUT,
  holdCitedAnnouncements,
} from "./maintenance.js";

type Fragment = ReturnType<typeof sql>;
type Executor = Pick<Db, "execute" | "transaction">;

export const NSE_MIRROR_PATTERN = "^(https?://(?:[^/?#]+\\.)?nseindia)\\.in(/|$)";
const NSE_MIRROR = new RegExp(NSE_MIRROR_PATTERN, "i");
export const DEDUPE_COMPANY_BATCH = 25;

export function canonicalAttachmentUrl(url: string | null | undefined): string | null {
  return url ? url.replace(NSE_MIRROR, "$1.com$2") : null;
}

export function announcementDedupeKey(a: {
  symbol: string;
  publishedAt: Date;
  subject: string;
  attachmentUrl: string | null | undefined;
}): string {
  return sha256(
    `${a.symbol}|${a.publishedAt.toISOString()}|${a.subject}|${canonicalAttachmentUrl(a.attachmentUrl) ?? ""}`,
  );
}

export function canonicalAttachmentSql(alias: Fragment): Fragment {
  return sql`regexp_replace(${alias}.attachment_url, ${NSE_MIRROR_PATTERN}, '\\1.com\\2', 'i')`;
}

export function firstAnnouncementCopy(alias: Fragment): Fragment {
  return sql`not exists (
    select 1 from announcements t
    where t.company_id = ${alias}.company_id and t.published_at = ${alias}.published_at
      and t.subject = ${alias}.subject and t.id <> ${alias}.id
      and ${canonicalAttachmentSql(sql`t`)} is not distinct from ${canonicalAttachmentSql(alias)}
      and (t.id < ${alias}.id
        or exists (select 1 from documents td where td.url = t.attachment_url)))`;
}

const sources = sql.join(
  ANNOUNCEMENT_DOCUMENT_SOURCES.map((s) => sql`${s}`),
  sql`, `,
);

export interface DedupeBatchResult {
  deleted: number;
  merged: number;
  rekeyed: number;
  lastCompanyId: number | null;
}

export interface DedupeResult {
  held: number;
  deleted: number;
  merged: number;
  rekeyed: number;
  batches: number;
  complete: boolean;
}

export async function duplicateAnnouncements(
  db: Pick<Db, "execute">,
  maxId: number,
): Promise<{ rows: number; distinct: number }> {
  const rows = await db.execute<{ rows: number; distinct: number }>(sql`
    select count(*)::int as rows,
      count(distinct (a.company_id, a.published_at, a.subject,
        coalesce(${canonicalAttachmentSql(sql`a`)}, '')))::int as distinct
    from announcements a where a.id <= ${maxId}`);
  return { rows: Number(rows[0]?.rows ?? 0), distinct: Number(rows[0]?.distinct ?? 0) };
}

export async function dedupeAnnouncementBatch(
  db: Executor,
  maxId: number,
  afterCompanyId: number,
  opts: { companies?: number; signal?: AbortSignal } = {},
): Promise<DedupeBatchResult> {
  return fencedTransaction(
    db,
    async (tx) => {
      const scope = await tx.execute<{ last: number | null }>(sql`
        select max(id)::int as last from (
          select id from companies where id > ${afterCompanyId}
          order by id limit ${opts.companies ?? DEDUPE_COMPANY_BATCH}) s`);
      const last = scope[0]?.last ?? null;
      if (last === null) return { deleted: 0, merged: 0, rekeyed: 0, lastCompanyId: null };
      await tx.execute(sql.raw(`set local statement_timeout = '${DELETE_STATEMENT_TIMEOUT}'`));
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${ANNOUNCEMENT_EVIDENCE_LOCK}))`);
      const counts = await tx.execute<{ deleted: number; merged: number }>(sql`
        with g as (
          select a.id, a.company_id, a.published_at, a.subject, a.attachment_url,
            a.materiality, a.so_what,
            coalesce(${canonicalAttachmentSql(sql`a`)}, '') as url_key,
            count(*) over (partition by a.company_id, a.published_at, a.subject,
              coalesce(${canonicalAttachmentSql(sql`a`)}, '')) as copies
          from announcements a
          where a.company_id > ${afterCompanyId} and a.company_id <= ${last} and a.id <= ${maxId}
        ), c as (
          select g.*,
            (exists (select 1 from announcement_holds h where h.announcement_id = g.id)
              or exists (select 1 from documents d where d.source in (${sources})
                and (d.url = ${ANNOUNCEMENT_DOCUMENT_PREFIX} || g.id::text
                  or d.url like ${ANNOUNCEMENT_DOCUMENT_PREFIX} || g.id::text || '/%'
                  or d.url = g.attachment_url))) as pinned,
            (g.materiality is not null or g.so_what is not null) as triaged
          from g where g.copies > 1
        ), r as (
          select c.id, c.pinned, c.triaged,
            row_number() over w as rn, first_value(c.id) over w as keep_id
          from c
          window w as (partition by c.company_id, c.published_at, c.subject, c.url_key
            order by c.pinned desc, c.triaged desc, c.id)
        ), donor as (
          select distinct on (r.keep_id) r.keep_id, a.materiality, a.triage_category, a.so_what,
            a.triage_model_version
          from r join announcements a on a.id = r.id
          where r.rn > 1 and not r.pinned and r.triaged
          order by r.keep_id, a.triage_model_version desc nulls last, a.id
        ), merged as (
          update announcements k set materiality = donor.materiality,
            triage_category = donor.triage_category, so_what = donor.so_what,
            triage_model_version = donor.triage_model_version
          from donor
          where k.id = donor.keep_id and k.materiality is null and k.so_what is null
          returning k.id
        ), deleted as (
          delete from announcements
          where id in (select id from r where r.rn > 1 and not r.pinned)
          returning id
        )
        select (select count(*) from deleted)::int as deleted,
          (select count(*) from merged)::int as merged`);
      const mirrored = await tx.execute<{
        id: number;
        symbol: string;
        subject: string;
        attachment_url: string;
        publishedMs: number;
      }>(sql`
        select a.id, c.nse_symbol as symbol, a.subject, a.attachment_url,
          (extract(epoch from a.published_at) * 1000)::float8 as "publishedMs"
        from announcements a join companies c on c.id = a.company_id
        where a.company_id > ${afterCompanyId} and a.company_id <= ${last} and a.id <= ${maxId}
          and c.nse_symbol is not null and a.attachment_url ~* ${NSE_MIRROR_PATTERN}`);
      let rekeyed = 0;
      if (mirrored.length) {
        const values = mirrored.map((r) => ({
          id: Number(r.id),
          key: announcementDedupeKey({
            symbol: r.symbol,
            publishedAt: new Date(Number(r.publishedMs)),
            subject: r.subject,
            attachmentUrl: r.attachment_url,
          }),
        }));
        const updated = await tx.execute<{ id: number }>(sql`
          update announcements a set dedupe_key = v.key
          from jsonb_to_recordset(${JSON.stringify(values)}::jsonb) as v(id int, key text)
          where a.id = v.id and a.dedupe_key <> v.key
            and not exists (select 1 from announcements o where o.dedupe_key = v.key)
          returning a.id`);
        rekeyed = updated.length;
      }
      return {
        deleted: Number(counts[0]?.deleted ?? 0),
        merged: Number(counts[0]?.merged ?? 0),
        rekeyed,
        lastCompanyId: last,
      };
    },
    opts.signal,
  );
}

export async function dedupeAnnouncements(
  db: Executor,
  opts: {
    maxId: number;
    expired: () => boolean;
    signal?: AbortSignal;
    companies?: number;
    pauseMs?: number;
  },
): Promise<DedupeResult> {
  const result: DedupeResult = {
    held: 0,
    deleted: 0,
    merged: 0,
    rekeyed: 0,
    batches: 0,
    complete: false,
  };
  result.held = await holdCitedAnnouncements(db, opts.maxId, opts.signal);
  let after = 0;
  for (;;) {
    if (opts.expired()) return result;
    throwIfAborted(opts.signal);
    const r = await dedupeAnnouncementBatch(db, opts.maxId, after, {
      ...(opts.companies ? { companies: opts.companies } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    if (r.lastCompanyId === null) break;
    result.deleted += r.deleted;
    result.merged += r.merged;
    result.rekeyed += r.rekeyed;
    result.batches++;
    after = r.lastCompanyId;
    if (r.deleted) await sleep(opts.pauseMs ?? DELETE_PAUSE_MS);
  }
  result.complete = true;
  return result;
}
