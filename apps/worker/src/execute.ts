import { AppError, DeadlineExceededError, type Logger, withDeadline } from "@ma/core";
import {
  type AttemptOutcome,
  asDeferred,
  contractOf,
  type FinishInput,
  familyOf,
  isRetryable,
  type JobEnvelope,
  type JobType,
  type Lease,
  laneOf,
  parseEnvelope,
  parsePayload,
  type RootOutcome,
  type RunInput,
  retryDelayMs,
  type StartInput,
  sanitizeError,
  unitKey,
} from "@ma/jobs";
import type { EnqueueRequest } from "@ma/jobs/queue";
import type { Metrics } from "./batch.js";
import type { WorkerContext } from "./context.js";
import { DEAD_METRIC, type MetricsSink } from "./metrics.js";
import type { ChildJob, Handler, HandlerMap, HandlerResult } from "./registry.js";

export const MAX_DEFERRALS = 60;
export const HARD_GRACE_MS = 15_000;

export class LeaseLostError extends AppError {
  constructor() {
    super("consumer lease lost; refusing to commit", "lease_lost", 503);
  }
}

export class WorkerStoppingError extends AppError {
  constructor() {
    super("worker stopping", "worker_stopping", 503);
  }
}

export interface QueueJob {
  id: string;
  data: unknown;
  retryCount: number;
}

export interface SpawnResult {
  campaignId: number;
  enqueued: number;
}

export interface LedgerPort {
  ensureRun(input: RunInput): Promise<number>;
  startAttempt(input: StartInput): Promise<number | null>;
  finishAttempt(input: FinishInput): Promise<boolean>;
  spawnChildren(source: string, children: ChildJob[], lease: Lease): Promise<SpawnResult>;
  recordRoot(outcome: RootOutcome): Promise<void>;
}

export interface RetryPort {
  send(request: EnqueueRequest<JobType>): Promise<unknown>;
}

export interface ExecutorDeps {
  ctx: WorkerContext;
  handlers: HandlerMap;
  ledger: LedgerPort;
  retry: RetryPort;
  lease: () => Lease | null;
  stop: AbortSignal;
  metrics: MetricsSink;
  invalidate: (family: string) => Promise<void>;
  logger: Pick<Logger, "info" | "warn" | "error">;
  now?: () => number;
  random?: () => number;
}

export type ExecutionOutcome = AttemptOutcome | "invalid";

export interface ExecutionReport {
  outcome: ExecutionOutcome;
  runId: number | null;
  attempt: number;
  metrics: Metrics;
  error?: string;
}

function invokeHandler(
  deps: ExecutorDeps,
  handler: Handler,
  env: JobEnvelope,
  attempt: number,
  deadline: number,
): Promise<HandlerResult> {
  const now = deps.now ?? Date.now;
  return new Promise<HandlerResult>((resolve, reject) => {
    if (deps.stop.aborted) {
      reject(new WorkerStoppingError());
      return;
    }
    const onStop = () => reject(new WorkerStoppingError());
    deps.stop.addEventListener("abort", onStop, { once: true });
    const timer = setTimeout(
      () => reject(new DeadlineExceededError(0, deadline - now())),
      Math.max(0, deadline - now()) + HARD_GRACE_MS,
    );
    withDeadline(deadline, (signal) =>
      handler({
        ctx: deps.ctx,
        type: env.type,
        payload: parsePayload(env.type, env.payload),
        attempt,
        campaignId: env.campaignId,
        deadline,
        signal: AbortSignal.any([signal, deps.stop]),
        expired: (reserveMs = 0) => now() + reserveMs >= deadline,
      }),
    )
      .then(resolve, reject)
      .finally(() => {
        clearTimeout(timer);
        deps.stop.removeEventListener("abort", onStop);
      });
  });
}

export async function executeJob(deps: ExecutorDeps, job: QueueJob): Promise<ExecutionReport> {
  const now = deps.now ?? Date.now;
  const random = deps.random ?? Math.random;
  const started = now();

  let env: JobEnvelope;
  try {
    env = parseEnvelope(job.data);
  } catch (err) {
    deps.logger.error({ jobId: job.id, err }, "invalid job envelope dropped");
    deps.metrics.count(DEAD_METRIC);
    return { outcome: "invalid", runId: null, attempt: 0, metrics: {}, error: sanitizeError(err) };
  }

  const lease = deps.lease();
  if (!lease) throw new LeaseLostError();

  const contract = contractOf(env.type);
  const family = familyOf(env.type);
  const key = unitKey(env.type, parsePayload(env.type, env.payload));
  const runId =
    env.runId ??
    (await deps.ledger.ensureRun({
      type: env.type,
      unitKey: key,
      campaignId: env.campaignId,
      lane: laneOf(env.type),
      payload: env.payload,
    }));
  const attempt = env.attemptBase + job.retryCount + 1;
  const deadline = started + contract.deadlineMs;
  const attemptId = await deps.ledger.startAttempt({
    runId,
    attempt,
    deadlineAt: new Date(deadline),
    queueJobId: job.id,
    lease,
  });
  if (attemptId === null) throw new LeaseLostError();
  const log = { job: env.type, unitKey: key, runId, attempt };

  const finish = async (outcome: AttemptOutcome, metrics: Metrics, error: string | null) => {
    const ok = await deps.ledger.finishAttempt({
      runId,
      attemptId,
      jobType: env.type,
      campaignId: env.campaignId,
      outcome,
      error,
      metrics,
      durationMs: now() - started,
      lease,
    });
    if (!ok) throw new LeaseLostError();
    deps.metrics.count(`jobs.${outcome}`);
  };

  const settleRoot = async (
    status: RootOutcome["status"],
    stats: Metrics,
    error: string | null,
  ) => {
    if (env.campaignId !== null || contract.kind !== "unit" || !family) return;
    await deps.ledger
      .recordRoot({ source: family, startedAt: new Date(started), status, stats, error })
      .catch((err: unknown) => deps.logger.warn({ ...log, err }, "root run record failed"));
  };

  const invalidate = async () => {
    if (contract.kind === "unit" && family) await deps.invalidate(family);
  };

  const handler = deps.handlers[env.type] as Handler;
  let result: HandlerResult;
  try {
    result = await invokeHandler(deps, handler, env, attempt, deadline);
  } catch (err) {
    const error = sanitizeError(err);
    if (deps.stop.aborted) {
      await finish("abandoned", {}, error).catch(() => undefined);
      throw err;
    }
    const deferred = asDeferred(err, new Date(now()), random);
    if (deferred && env.deferrals < MAX_DEFERRALS) {
      await finish("deferred", {}, error);
      await deps.retry.send({
        type: env.type,
        payload: env.payload as never,
        campaignId: env.campaignId,
        runId,
        startAfter: deferred.resumeAt,
        attemptBase: attempt - 1,
        deferrals: env.deferrals + 1,
      });
      deps.logger.info({ ...log, resumeAt: deferred.resumeAt }, "job deferred");
      return { outcome: "deferred", runId, attempt, metrics: {}, error };
    }
    if (!deferred && isRetryable(err) && attempt <= contract.retryLimit) {
      await finish("failed", {}, error);
      const delay = retryDelayMs(attempt, err, random);
      await deps.retry.send({
        type: env.type,
        payload: env.payload as never,
        campaignId: env.campaignId,
        runId,
        startAfter: new Date(now() + delay),
        attemptBase: attempt,
        deferrals: env.deferrals,
      });
      deps.logger.warn({ ...log, err, retryInMs: delay }, "job failed; retry scheduled");
      return { outcome: "failed", runId, attempt, metrics: {}, error };
    }
    await finish("dead", {}, error);
    deps.logger.error({ ...log, err }, "job dead");
    await settleRoot("failed", {}, error);
    await invalidate();
    return { outcome: "dead", runId, attempt, metrics: {}, error };
  }

  const metrics = { ...result.metrics };
  if (contract.kind === "fanout" || result.children?.length) {
    const spawned = await deps.ledger.spawnChildren(
      family ?? env.type,
      result.children ?? [],
      lease,
    );
    metrics.enqueued = spawned.enqueued;
    metrics.campaignId = spawned.campaignId;
  }
  await finish("succeeded", metrics, null);
  await settleRoot("succeeded", metrics, null);
  await invalidate();
  return { outcome: "succeeded", runId, attempt, metrics };
}
