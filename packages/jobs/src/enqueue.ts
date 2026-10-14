import { randomUUID } from "node:crypto";
import { chunk } from "@ma/core";
import { sql } from "@ma/db";
import { fromDrizzle, type JobInsert, type PgBoss, type SendOptions } from "pg-boss";
import {
  contractOf,
  type JobEnvelope,
  type JobPayload,
  type JobType,
  LANES,
  laneOf,
  parsePayload,
  unitKey,
} from "./contracts.js";
import {
  deleteRun,
  deleteRuns,
  ensureRun,
  ensureRuns,
  type RunInput,
  runKey,
  type Tx,
} from "./ledger.js";
import { BACKOFF_BASE_MS, BACKOFF_MAX_MS } from "./policies.js";

export const DEAD_QUEUE = "dead";
export const PG_BOSS_SCHEMA = "pgboss";
const COMPLETED_RETENTION_SECONDS = 2 * 24 * 3600;
const DEAD_RETENTION_SECONDS = 14 * 24 * 3600;
const PENDING_RETENTION_SECONDS = 14 * 24 * 3600;
const EXPIRY_MARGIN_SECONDS = 60;

export type QueueClient = Pick<PgBoss, "send">;

export interface EnqueueRequest<T extends JobType> {
  type: T;
  payload: JobPayload<T>;
  campaignId?: number | null;
  startAfter?: Date;
  priority?: number;
  attemptBase?: number;
  deferrals?: number;
  runId?: number | null;
}

export interface EnqueueResult {
  jobId: string | null;
  runId: number | null;
  unitKey: string;
}

export function expireSeconds(type: JobType): number {
  return Math.ceil(contractOf(type).deadlineMs / 1000) + EXPIRY_MARGIN_SECONDS;
}

export function sendOptions(
  type: JobType,
  key: string,
  extra: { startAfter?: Date; priority?: number; attemptBase?: number } = {},
): SendOptions {
  const retryLimit = Math.max(0, contractOf(type).retryLimit - (extra.attemptBase ?? 0));
  return {
    singletonKey: key,
    retryLimit,
    expireInSeconds: expireSeconds(type),
    ...(extra.startAfter ? { startAfter: extra.startAfter } : {}),
    ...(extra.priority !== undefined ? { priority: extra.priority } : {}),
  };
}

export async function enqueue<T extends JobType>(
  boss: QueueClient,
  request: EnqueueRequest<T>,
  tx?: Tx,
): Promise<EnqueueResult> {
  const payload = parsePayload(request.type, request.payload) as Record<string, unknown>;
  const key = unitKey(request.type, request.payload);
  const lane = laneOf(request.type);
  const campaignId = request.campaignId ?? null;
  const runId =
    request.runId ??
    (tx
      ? await ensureRun(tx, { type: request.type, unitKey: key, campaignId, lane, payload })
      : null);
  const created = request.runId == null && runId !== null;
  const envelope: JobEnvelope = {
    type: request.type,
    payload,
    campaignId,
    runId,
    attemptBase: request.attemptBase ?? 0,
    deferrals: request.deferrals ?? 0,
    ...(request.priority !== undefined ? { priority: request.priority } : {}),
  };
  const options: SendOptions = {
    ...sendOptions(request.type, key, request),
    ...(tx ? { db: fromDrizzle(tx, sql) } : {}),
  };
  const jobId = await boss.send(lane, { ...envelope }, options);
  if (jobId === null && tx && created && runId !== null) {
    await deleteRun(tx, runId);
    return { jobId, runId: null, unitKey: key };
  }
  return { jobId, runId, unitKey: key };
}

export const ENQUEUE_BATCH = 200;

export interface ManyChild<T extends JobType = JobType> {
  type: T;
  payload: JobPayload<T>;
  priority?: number;
}

export async function enqueueMany(
  boss: Pick<PgBoss, "insert">,
  campaignId: number,
  children: ManyChild[],
  tx: Tx,
): Promise<number> {
  const db = fromDrizzle(tx, sql);
  const seen = new Set<string>();
  const unique: Array<RunInput & { priority?: number }> = [];
  for (const child of children) {
    const payload = parsePayload(child.type, child.payload) as Record<string, unknown>;
    const key = unitKey(child.type, child.payload);
    if (seen.has(runKey(child.type, key))) continue;
    seen.add(runKey(child.type, key));
    unique.push({
      type: child.type,
      unitKey: key,
      campaignId,
      lane: laneOf(child.type),
      payload,
      ...(child.priority !== undefined ? { priority: child.priority } : {}),
    });
  }
  let enqueued = 0;
  for (const batch of chunk(unique, ENQUEUE_BATCH)) {
    const runIds = await ensureRuns(tx, batch);
    const byLane = new Map<string, Array<{ job: JobInsert; runId: number }>>();
    for (const run of batch) {
      const type = run.type as JobType;
      const runId = runIds.get(runKey(type, run.unitKey));
      if (runId === undefined) throw new Error(`job_runs upsert lost ${run.unitKey}`);
      const envelope: JobEnvelope = {
        type,
        payload: run.payload,
        campaignId,
        runId,
        attemptBase: 0,
        deferrals: 0,
        ...(run.priority !== undefined ? { priority: run.priority } : {}),
      };
      const opts = sendOptions(type, run.unitKey, {
        ...(run.priority !== undefined ? { priority: run.priority } : {}),
      });
      const job: JobInsert = {
        id: randomUUID(),
        data: envelope,
        singletonKey: run.unitKey,
        ...(opts.retryLimit !== undefined ? { retryLimit: opts.retryLimit } : {}),
        ...(opts.expireInSeconds !== undefined ? { expireInSeconds: opts.expireInSeconds } : {}),
        ...(opts.priority !== undefined ? { priority: opts.priority } : {}),
      };
      const list = byLane.get(run.lane) ?? [];
      list.push({ job, runId });
      byLane.set(run.lane, list);
    }
    for (const [lane, items] of byLane) {
      const ids = new Set(
        (await boss.insert(
          lane,
          items.map((i) => i.job),
          { db, returnId: true },
        )) ?? [],
      );
      enqueued += ids.size;
      await deleteRuns(
        tx,
        items.filter((i) => !ids.has(i.job.id as string)).map((i) => i.runId),
      );
    }
  }
  return enqueued;
}

export const LANE_QUEUE_OPTIONS = {
  policy: "stately",
  retryLimit: 4,
  retryDelay: BACKOFF_BASE_MS / 1000,
  retryBackoff: true,
  retryDelayMax: BACKOFF_MAX_MS / 1000,
  deleteAfterSeconds: COMPLETED_RETENTION_SECONDS,
  retentionSeconds: PENDING_RETENTION_SECONDS,
  deadLetter: DEAD_QUEUE,
} as const;

export async function ensureQueues(
  boss: Pick<PgBoss, "getQueue" | "createQueue" | "updateQueue">,
): Promise<void> {
  if (!(await boss.getQueue(DEAD_QUEUE))) {
    await boss.createQueue(DEAD_QUEUE, {
      policy: "standard",
      retryLimit: 0,
      deleteAfterSeconds: DEAD_RETENTION_SECONDS,
      retentionSeconds: DEAD_RETENTION_SECONDS,
    });
  }
  for (const lane of LANES) {
    if (await boss.getQueue(lane)) {
      const { policy: _policy, ...updatable } = LANE_QUEUE_OPTIONS;
      await boss.updateQueue(lane, updatable);
    } else {
      await boss.createQueue(lane, { ...LANE_QUEUE_OPTIONS });
    }
  }
}
