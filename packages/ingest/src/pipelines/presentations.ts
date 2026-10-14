import { DAY, DeadlineExceededError, isoDate, throwIfAborted } from "@ma/core";
import { sql } from "@ma/db";
import type { IngestContext } from "../context.js";
import { noteSourceError, registerSource } from "../relationships/graph.js";

const PRESENTATION_LOOKBACK_DAYS = 200;
const STORED_MAX_AGE_MS = 3_650 * DAY;

export interface PresentationSyncResult {
  status: "registered" | "current" | "none" | "failed";
  documentId: number | null;
}

const LATEST_PRESENTATION = sql`
  select a.id, a.company_id, a.published_at, a.subject, a.attachment_url
  from announcements a
  where a.category_key = 'investor_presentation' and a.attachment_url is not null
    and a.published_at > now() - make_interval(days => ${PRESENTATION_LOOKBACK_DAYS})`;

const PRESENTATION_UNREAD = sql`not exists (
  select 1 from relationship_sources rs
  join documents d on d.id = rs.document_id
  where rs.company_id = p.company_id and rs.family = 'presentation'
    and d.url = p.attachment_url)`;

export const PRESENTATIONS_PENDING = sql`exists (
  select 1 from (
    select l.company_id, l.attachment_url from (${LATEST_PRESENTATION}) l
    where l.company_id = c.id
    order by l.published_at desc, l.id desc
    limit 1
  ) p
  where ${PRESENTATION_UNREAD})`;

export async function syncLatestPresentation(
  ctx: IngestContext,
  companyId: number,
  signal?: AbortSignal,
): Promise<PresentationSyncResult> {
  const [latest] = await ctx.db.execute<{
    id: number;
    published_at: string | Date;
    subject: string;
    attachment_url: string;
  }>(sql`
    select l.id, l.published_at, l.subject, l.attachment_url
    from (${LATEST_PRESENTATION}) l
    where l.company_id = ${companyId}
    order by l.published_at desc, l.id desc
    limit 1`);
  if (!latest) return { status: "none", documentId: null };
  const publishedAt = new Date(latest.published_at);
  try {
    const fetched = await ctx.docs.fetch(latest.attachment_url, {
      source: "presentation",
      companyId,
      maxAgeMs: STORED_MAX_AGE_MS,
      publishedAt,
      ...(signal ? { signal } : {}),
    });
    const registered = await registerSource(ctx.db, {
      companyId,
      family: "presentation",
      documentId: fetched.doc.id,
      label: latest.subject.slice(0, 300),
      publishedAt: isoDate(publishedAt),
    });
    return {
      status: registered.readRevisionId === fetched.revision.id ? "current" : "registered",
      documentId: fetched.doc.id,
    };
  } catch (err) {
    if (err instanceof DeadlineExceededError) throw err;
    throwIfAborted(signal);
    ctx.logger.warn({ err, companyId, url: latest.attachment_url }, "presentation fetch failed");
    await noteSourceError(ctx.db, companyId, "presentation", latest.attachment_url, err);
    return { status: "failed", documentId: null };
  }
}
