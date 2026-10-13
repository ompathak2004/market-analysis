import { AppError, DeadlineExceededError, type Logger, withDeadline } from "@ma/core";
import {
  type AttemptOutcome,
  asDeferred,
  assertFence,
  contractOf,
  type Executor,
  type Fence,
  type FinishInput,
  familyOf,
  isRetryable,
  type JobEnvelope,
  type JobType,
  type Lease,
  LeaseLostError,
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
export const ABORT_SETTLE_MS = 10_000;

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
  replayed: boolean;
}

export interface FanoutCompletion extends FinishInput {
  source: string;
  children: ChildJob[];
  queueJobId: string;
}

export interface LedgerPort {
  ensureRun(input: RunInput): Promise<number>;
  startAttempt(input: StartInput): Promise<number | null>;
  finishAttempt(input: FinishInput): Promise<boolean>;
  completeFanout(input: FanoutCompletion): Promise<SpawnResult>;
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

type Invocation =
  | { ok: true; value: HandlerResult }
  | { ok: false; error: unknown; settled: boolean };

function invokeHandler(
  deps: ExecutorDeps,
  handler: Handler,
  env: JobEnvelope,
  attempt: number,
  deadline: number,
  fence: Fence,
): Promise<Invocation> {
  const now = deps.now ?? Date.now;
  if (deps.stop.aborted)
    return Promise.resolve({ ok: false, error: new WorkerStoppingError(), settled: true });
  const abort = new AbortController();
  const work: Promise<Invocation> = withDeadline(
    deadline,
    (signal) =>
      handler({
        ctx: deps.ctx,
        type: env.type,
        payload: parsePayload(env.type, env.payload),
        attempt,
        campaignId: env.campaignId,
        deadline,
        signal,
        fence,
        expired: (reserveMs = 0) => now() + reserveMs >= deadline,
      }),
    {
      signal: AbortSignal.any([abort.signal, deps.stop]),
      commitGuard: (tx) => assertFence(tx as Executor, fence),
    },
  ).then(
    (value) => ({ ok: true, value }),
    (error: unknown) => ({ ok: false, error, settled: true }),
  );

  const timers: NodeJS.Timeout[] = [];
  let onStop = () => {};
  const interrupted = new Promise<Error>((resolve) => {
    onStop = () => resolve(new WorkerStoppingError());
    deps.stop.addEventListener("abort", onStop, { once: true });
    // The handler starts synchronously above and may already have seen the stop fire.
    if (deps.stop.aborted) onStop();
    timers.push(
      setTimeout(
        () => resolve(new DeadlineExceededError(0, deadline - now())),
        Math.max(0, deadline - now()) + HARD_GRACE_MS,
      ),
    );
  });
  const graceExpired = () =>
    new Promise<null>((resolve) => timers.push(setTimeout(() => resolve(null), ABORT_SETTLE_MS)));

  return Promise.race([work, interrupted])
    .then(async (first): Promise<Invocation> => {
      if (!(first instanceof Error)) return first;
      abort.abort(first);
      const late = await Promise.race([work, graceExpired()]);
      return { ok: false, error: first, settled: late !== null };
    })
    .finally(() => {
      for (const t of timers) clearTimeout(t);
      deps.stop.removeEventListener("abort", onStop);
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

  const finishInput = (
    outcome: AttemptOutcome,
    metrics: Metrics,
    error: string | null,
  ): FinishInput => ({
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

  const finish = async (outcome: AttemptOutcome, metrics: Metrics, error: string | null) => {
    const ok = await deps.ledger.finishAttempt(finishInput(outcome, metrics, error));
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
  const invocation = await invokeHandler(deps, handler, env, attempt, deadline, {
    lease,
    attemptId,
  });
  let result: HandlerResult;
  if (invocation.ok) result = invocation.value;
  else {
    const err = invocation.error;
    const error = sanitizeError(err);
    if (deps.stop.aborted) {
      await finish("abandoned", {}, error).catch(() => undefined);
      // A handler still running past the abort grace may keep writing; a pg-boss retry would
      // race it on the next worker, so the job completes and the run stays abandoned.
      if (!invocation.settled) {
        deps.logger.error({ ...log, err }, "handler ignored stop; abandoned without retry");
        return { outcome: "abandoned", runId, attempt, metrics: {}, error };
      }
      throw err instanceof WorkerStoppingError ? err : new WorkerStoppingError();
    }
    if (!invocation.settled) {
      await finish("abandoned", {}, error);
      deps.logger.error({ ...log, err }, "handler ignored abort; abandoned without retry");
      return { outcome: "abandoned", runId, attempt, metrics: {}, error };
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
        ...(env.priority !== undefined ? { priority: env.priority } : {}),
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
        ...(env.priority !== undefined ? { priority: env.priority } : {}),
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
    const spawned = await deps.ledger.completeFanout({
      ...finishInput("succeeded", metrics, null),
      source: family ?? env.type,
      children: result.children ?? [],
      queueJobId: job.id,
    });
    metrics.enqueued = spawned.enqueued;
    metrics.campaignId = spawned.campaignId;
    if (spawned.replayed)
      deps.logger.info({ ...log, ...metrics }, "fan-out replay reused campaign");
    deps.metrics.count("jobs.succeeded");
  } else await finish("succeeded", metrics, null);
  await settleRoot("succeeded", metrics, null);
  await invalidate();
  return { outcome: "succeeded", runId, attempt, metrics };
}
