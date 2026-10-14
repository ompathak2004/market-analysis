import { chunk, DAY, throwIfAborted } from "@ma/core";
import {
  and,
  documentRevisions,
  documents,
  eq,
  fencedTransaction,
  inArray,
  isNull,
  sql,
  storageObjects,
} from "@ma/db";
import type { Metrics } from "../batch.js";
import { done, fanout, type HandlerMap } from "../registry.js";

const SNAPSHOT_PER_FANOUT = 2_000;
const SNAPSHOT_PER_UNIT = 50;
const GC_AFTER_MS = 7 * DAY;
const GC_BATCH = 500;
const RELEASE_BATCH = 200;
const RELEASE_RESERVE_MS = 20_000;

export const SPLC_DOCUMENT_SOURCES = [
  "annual_report",
  "concall",
  "order_filing",
  "announcement_metadata",
  "rating_rationale",
  "presentation",
] as const;

type DocumentHandlers = Pick<
  HandlerMap,
  "documents.snapshot" | "documents.revision" | "documents.gc" | "documents.release"
>;

export const documentHandlers: DocumentHandlers = {
  "documents.snapshot": async ({ ctx }) => {
    const rows = await ctx.db
      .select({ id: documents.id })
      .from(documents)
      .where(and(isNull(documents.currentRevisionId), sql`${documents.content} is not null`))
      .orderBy(documents.id)
      .limit(SNAPSHOT_PER_FANOUT);
    return fanout(
      "documents.revision",
      chunk(
        rows.map((r) => r.id),
        SNAPSHOT_PER_UNIT,
      ).map((documentIds) => ({ documentIds })),
    );
  },
  "documents.revision": async ({ ctx, payload, signal }) => {
    const metrics: Metrics = { created: 0, existing: 0, uploaded: 0, empty: 0 };
    const rows = await ctx.db.query.documents.findMany({
      where: inArray(documents.id, payload.documentIds),
    });
    for (const doc of rows) {
      throwIfAborted(signal);
      const snap = await ctx.docs.snapshot(doc, signal);
      if (!snap) metrics.empty = (metrics.empty ?? 0) + 1;
      else if (snap.created) {
        metrics.created = (metrics.created ?? 0) + 1;
        if (snap.uploaded) metrics.uploaded = (metrics.uploaded ?? 0) + 1;
      } else metrics.existing = (metrics.existing ?? 0) + 1;
    }
    return done(metrics);
  },
  "documents.gc": async ({ ctx, signal }) => {
    const metrics: Metrics = { candidates: 0, removed: 0 };
    if (!ctx.objects) return done({ ...metrics, skipped: 1 });
    const orphans = await ctx.db.execute<{ key: string }>(sql`
      select o.key from storage_objects o
      where o.kind = 'text'
        and o.created_at < now() - (${GC_AFTER_MS} * interval '1 millisecond')
        and not exists (
          select 1 from document_revisions r
          where r.text_s3_key = o.key or r.raw_s3_key = o.key)
      order by o.created_at
      limit ${GC_BATCH}`);
    metrics.candidates = orphans.length;
    for (const batch of chunk(
      orphans.map((o) => o.key),
      100,
    )) {
      throwIfAborted(signal);
      await ctx.objects.remove(batch);
      await fencedTransaction(
        ctx.db,
        (tx) => tx.delete(storageObjects).where(inArray(storageObjects.key, batch)),
        signal,
      );
      metrics.removed = (metrics.removed ?? 0) + batch.length;
    }
    return done(metrics);
  },
  "documents.release": async ({ ctx, signal, expired }) => {
    const metrics: Metrics = { candidates: 0, released: 0, unverified: 0 };
    const objects = ctx.objects;
    if (!objects) return done({ ...metrics, skipped: 1 });
    const rows = await ctx.db
      .select({
        id: documents.id,
        key: documentRevisions.textS3Key,
        bytes: storageObjects.bytes,
      })
      .from(documents)
      .innerJoin(documentRevisions, eq(documentRevisions.id, documents.currentRevisionId))
      .innerJoin(storageObjects, eq(storageObjects.key, documentRevisions.textS3Key))
      .where(
        and(
          sql`${documents.content} is not null`,
          eq(documents.status, "parsed"),
          sql`${documents.source} not in (${sql.join(
            SPLC_DOCUMENT_SOURCES.map((s) => sql`${s}`),
            sql`, `,
          )})`,
          sql`not exists (
            select 1 from relationship_extractions x
            where x.document_revision_id = ${documentRevisions.id}
              and x.status <> 'succeeded')`,
        ),
      )
      .orderBy(documents.id)
      .limit(RELEASE_BATCH);
    metrics.candidates = rows.length;
    for (const row of rows) {
      throwIfAborted(signal);
      if (expired(RELEASE_RESERVE_MS)) break;
      if (!row.key) continue;
      const head = await objects.head(row.key);
      if (!head || head.bytes !== row.bytes) {
        metrics.unverified = (metrics.unverified ?? 0) + 1;
        continue;
      }
      await fencedTransaction(
        ctx.db,
        (tx) => tx.update(documents).set({ content: null }).where(eq(documents.id, row.id)),
        signal,
      );
      metrics.released = (metrics.released ?? 0) + 1;
    }
    return done(metrics);
  },
};
