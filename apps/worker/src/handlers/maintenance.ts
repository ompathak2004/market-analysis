import { isoDate, MINUTE } from "@ma/core";
import {
  ANNOUNCEMENT_POLICY_VERSION,
  announcementFootprint,
  announcementMaxId,
  backupAnnouncements,
  type ClassifyResult,
  classifyAnnouncementRange,
  classifyRanges,
  dedupeAnnouncements,
  deleteExpiredAnnouncements,
  duplicateAnnouncements,
  reindexAnnouncements,
  unclassifiedAnnouncements,
  verifyBackup,
} from "@ma/ingest";
import { DeferredError, invalidateAfterJob, NonRetryableError } from "@ma/jobs";
import type { WorkerContext } from "../context.js";
import { fanout, type HandlerMap } from "../registry.js";

const STEP_RESERVE_MS = 30_000;
const RESUME_DELAY_MS = 5_000;
const VACUUM_WAIT_MS = 5 * MINUTE;
export const BACKUP_UNENCRYPTED_METRIC = "maintenance.backup.unencrypted";
export const REINDEX_DENIED_METRIC = "maintenance.reindex.denied";

function objectStore(ctx: WorkerContext) {
  if (!ctx.objects) {
    throw new NonRetryableError(
      "S3_ARCHIVE_BUCKET is not set; announcements are never cleaned without a backup",
    );
  }
  return ctx.objects;
}

const resumeSoon = (reason: string) =>
  new DeferredError(new Date(Date.now() + RESUME_DELAY_MS), reason);

async function backupStep(
  ctx: WorkerContext,
  payload: { day: string; maxId: number },
  signal: AbortSignal | undefined,
  table: string,
) {
  const encryptionKey = ctx.env.BACKUP_ENCRYPTION_KEY ?? null;
  if (!encryptionKey) {
    ctx.metrics.count(BACKUP_UNENCRYPTED_METRIC);
    ctx.logger.warn(
      payload,
      "BACKUP_ENCRYPTION_KEY is not set; the announcement backup is unencrypted",
    );
  }
  const backup = await backupAnnouncements(ctx.db, objectStore(ctx), {
    ...payload,
    encryptionKey,
    table,
    ...(signal ? { signal } : {}),
  });
  ctx.logger.info({ ...payload, ...backup }, "announcement backup verified");
  return backup;
}

async function requireBackup(ctx: WorkerContext, backupKey: string) {
  if (!(await verifyBackup(ctx.db, objectStore(ctx), backupKey))) {
    throw new NonRetryableError(`backup ${backupKey} is not verified in object storage`);
  }
}

type MaintenanceHandlers = Pick<
  HandlerMap,
  | "maintenance.announcements"
  | "maintenance.announcements.backup"
  | "maintenance.announcements.classify"
  | "maintenance.announcements.delete"
  | "maintenance.announcements.reindex"
  | "maintenance.announcements.dedupe"
  | "maintenance.announcements.dedupe.backup"
  | "maintenance.announcements.dedupe.delete"
>;

export const maintenanceHandlers: MaintenanceHandlers = {
  "maintenance.announcements": async ({ ctx }) => {
    objectStore(ctx);
    const maxId = await announcementMaxId(ctx.db);
    return fanout(
      "maintenance.announcements.backup",
      maxId ? [{ day: isoDate(new Date()), maxId }] : [],
    );
  },
  "maintenance.announcements.backup": async ({ ctx, payload, signal }) => {
    const backup = await backupStep(ctx, payload, signal, "announcements");
    return {
      metrics: { rows: backup.rows, bytes: backup.bytes, encrypted: backup.encrypted ? 1 : 0 },
      children: [
        {
          type: "maintenance.announcements.classify",
          payload: { ...payload, backupKey: backup.key },
        },
      ],
    };
  },
  "maintenance.announcements.classify": async ({ ctx, payload, signal, expired }) => {
    const totals: ClassifyResult = { scanned: 0, updated: 0, forever: 0, fiveYears: 0, noise: 0 };
    for (const range of await classifyRanges(ctx.db, payload.maxId)) {
      if (expired(STEP_RESERVE_MS)) {
        ctx.logger.info({ ...payload, ...totals }, "announcement classification paused");
        throw resumeSoon(`classified ${totals.updated} announcements`);
      }
      const r = await classifyAnnouncementRange(ctx.db, range, signal);
      for (const key of Object.keys(totals) as (keyof ClassifyResult)[]) totals[key] += r[key];
    }
    return {
      metrics: { ...totals },
      children: [{ type: "maintenance.announcements.delete", payload }],
    };
  },
  "maintenance.announcements.delete": async ({ ctx, payload, signal, expired }) => {
    await requireBackup(ctx, payload.backupKey);
    const pending = await unclassifiedAnnouncements(ctx.db, payload.maxId);
    if (pending) {
      throw new NonRetryableError(
        `${pending} announcements are not classified at policy v${ANNOUNCEMENT_POLICY_VERSION}`,
      );
    }
    const r = await deleteExpiredAnnouncements(ctx.db, {
      maxId: payload.maxId,
      expired: () => expired(STEP_RESERVE_MS),
      signal,
    });
    if (r.noise + r.expired) await invalidateAfterJob(ctx, "announcements");
    ctx.logger.info({ ...payload, ...r }, "announcement delete slice");
    if (r.vacuumWait) {
      throw new DeferredError(new Date(Date.now() + VACUUM_WAIT_MS), "waiting for autovacuum");
    }
    if (!r.complete) throw resumeSoon(`deleted ${r.noise + r.expired} announcements`);
    const footprint = await announcementFootprint(ctx.db);
    return {
      metrics: {
        held: r.held,
        noise: r.noise,
        expired: r.expired,
        batches: r.batches,
        remaining: footprint.rows,
        bytes: footprint.bytes,
      },
      children: [
        {
          type: "maintenance.announcements.reindex",
          payload: { day: payload.day, maxId: payload.maxId },
        },
      ],
    };
  },
  "maintenance.announcements.reindex": async ({ ctx }) => {
    const before = await announcementFootprint(ctx.db);
    const r = await reindexAnnouncements(ctx.db);
    if (r.denied) {
      ctx.metrics.count(REINDEX_DENIED_METRIC, r.denied);
      ctx.logger.warn(r, "the worker role cannot reindex announcements; run it as the table owner");
    }
    const after = await announcementFootprint(ctx.db);
    return {
      metrics: { ...r, rows: after.rows, bytesBefore: before.bytes, bytesAfter: after.bytes },
    };
  },
  "maintenance.announcements.dedupe": async ({ ctx }) => {
    objectStore(ctx);
    const maxId = await announcementMaxId(ctx.db);
    return fanout(
      "maintenance.announcements.dedupe.backup",
      maxId ? [{ day: isoDate(new Date()), maxId }] : [],
    );
  },
  "maintenance.announcements.dedupe.backup": async ({ ctx, payload, signal }) => {
    const backup = await backupStep(ctx, payload, signal, "announcements-dedupe");
    return {
      metrics: { rows: backup.rows, bytes: backup.bytes, encrypted: backup.encrypted ? 1 : 0 },
      children: [
        {
          type: "maintenance.announcements.dedupe.delete",
          payload: { ...payload, backupKey: backup.key },
        },
      ],
    };
  },
  "maintenance.announcements.dedupe.delete": async ({ ctx, payload, signal, expired }) => {
    await requireBackup(ctx, payload.backupKey);
    const r = await dedupeAnnouncements(ctx.db, {
      maxId: payload.maxId,
      expired: () => expired(STEP_RESERVE_MS),
      signal,
    });
    if (r.deleted || r.merged) await invalidateAfterJob(ctx, "announcements");
    ctx.logger.info({ ...payload, ...r }, "announcement dedupe slice");
    if (!r.complete) throw resumeSoon(`deleted ${r.deleted} duplicate announcements`);
    const left = await duplicateAnnouncements(ctx.db, payload.maxId);
    return {
      metrics: {
        held: r.held,
        deleted: r.deleted,
        merged: r.merged,
        rekeyed: r.rekeyed,
        batches: r.batches,
        rows: left.rows,
        distinct: left.distinct,
      },
    };
  },
};
