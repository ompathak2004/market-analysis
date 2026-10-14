import { DAY, DeadlineExceededError, isoDate, remainingMs, throwIfAborted } from "@ma/core";
import { type Db, sql } from "@ma/db";
import type { IngestContext } from "../context.js";
import type { FetchDocumentResult } from "../documents.js";
import { registerSource } from "../relationships/graph.js";
import {
  parseRatingRationale,
  RATING_RATIONALE_PARSER_VERSION,
  ratingLabel,
  ratingLinksIn,
} from "../sources/ratings.js";

export const RATINGS_PER_RUN = 8;
export const RATING_LOOKBACK_DAYS = 400;
const DOCUMENT_MS = 20_000;
const STORED_MAX_AGE_MS = 3_650 * DAY;
const RETRY_MS = 7 * DAY;

export function ratingAnnouncementUrl(announcementId: number): string {
  return `nse://announcement/${announcementId}/rating`;
}

export const RATING_ANNOUNCEMENT = sql`(a.category_key = 'credit_rating'
  and a.published_at > now() - make_interval(days => ${RATING_LOOKBACK_DAYS}))`;

export const RATING_ANNOUNCEMENT_UNREAD = sql`not exists (
  select 1 from relationship_sources rs
  join documents d on d.id = rs.document_id
  where rs.company_id = a.company_id and rs.family = 'rating_rationale'
    and (d.url = a.attachment_url
      or d.url = 'nse://announcement/' || a.id::text || '/rating'))`;

export const RATINGS_PENDING = sql`exists (
  select 1 from announcements a
  where a.company_id = c.id and ${RATING_ANNOUNCEMENT} and ${RATING_ANNOUNCEMENT_UNREAD})`;

export interface RatingAnnouncement {
  id: number;
  publishedAt: Date;
  subject: string;
  details: string | null;
  attachmentUrl: string | null;
}

export interface RatingSyncResult {
  announcements: number;
  documents: number;
  failed: number;
  remaining: number;
}

export async function pendingRatingAnnouncements(
  db: Db,
  companyId: number,
  limit = RATINGS_PER_RUN,
): Promise<RatingAnnouncement[]> {
  const rows = await db.execute<{
    id: number;
    published_at: string | Date;
    subject: string;
    details: string | null;
    attachment_url: string | null;
  }>(sql`
    select a.id, a.published_at, a.subject, a.details, a.attachment_url
    from announcements a
    where a.company_id = ${companyId} and ${RATING_ANNOUNCEMENT} and ${RATING_ANNOUNCEMENT_UNREAD}
    order by a.published_at desc
    limit ${limit}`);
  return rows.map((r) => ({
    id: Number(r.id),
    publishedAt: new Date(r.published_at),
    subject: r.subject,
    details: r.details,
    attachmentUrl: r.attachment_url,
  }));
}

async function register(
  ctx: IngestContext,
  companyId: number,
  a: RatingAnnouncement,
  fetched: FetchDocumentResult,
  url: string | null,
): Promise<void> {
  const parsed = parseRatingRationale(fetched.text, url ?? undefined);
  await ctx.docs.markParsed(fetched.doc.id, RATING_RATIONALE_PARSER_VERSION);
  await registerSource(ctx.db, {
    companyId,
    family: "rating_rationale",
    documentId: fetched.doc.id,
    label: ratingLabel(parsed, a.subject),
    publishedAt: parsed.date ?? isoDate(a.publishedAt),
  });
}

export async function syncRatingRationales(
  ctx: IngestContext,
  companyId: number,
  signal?: AbortSignal,
): Promise<RatingSyncResult> {
  const queue = await pendingRatingAnnouncements(ctx.db, companyId);
  const result: RatingSyncResult = { announcements: 0, documents: 0, failed: 0, remaining: 0 };
  const docOpts = (a: RatingAnnouncement) => ({
    source: "rating_rationale",
    companyId,
    publishedAt: a.publishedAt,
    ...(signal ? { signal } : {}),
  });
  const attempt = async (url: string, a: RatingAnnouncement, direct: boolean) => {
    try {
      const fetched = await ctx.docs.fetch(url, {
        ...docOpts(a),
        maxAgeMs: STORED_MAX_AGE_MS,
        ...(direct ? { via: "direct_only" as const } : {}),
      });
      await register(ctx, companyId, a, fetched, url);
      result.documents++;
      return true;
    } catch (err) {
      if (err instanceof DeadlineExceededError) throw err;
      throwIfAborted(signal);
      ctx.logger.warn({ err, companyId, url }, "rating rationale fetch failed");
      result.failed++;
      return false;
    }
  };

  for (const [i, a] of queue.entries()) {
    throwIfAborted(signal);
    if (remainingMs() < DOCUMENT_MS) {
      result.remaining = queue.length - i;
      break;
    }
    const links = ratingLinksIn(`${a.subject}\n${a.details ?? ""}`);
    let linked = false;
    for (const url of links) {
      if (await attempt(url, a, true)) linked = true;
    }
    const attached = a.attachmentUrl ? await attempt(a.attachmentUrl, a, false) : false;
    const fetchable = a.attachmentUrl !== null || links.length > 0;
    const retry = !linked && fetchable && Date.now() - a.publishedAt.getTime() < RETRY_MS;
    if (!attached && !retry) {
      const content = a.details?.trim() ? `${a.subject}\n${a.details}` : a.subject;
      const inline = await ctx.docs.putInline(ratingAnnouncementUrl(a.id), content, docOpts(a));
      await register(ctx, companyId, a, inline, null);
    }
    result.announcements++;
  }
  ctx.logger.info({ companyId, ...result }, "rating rationales synced");
  return result;
}
