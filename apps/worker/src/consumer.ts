import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { MINUTE } from "@ma/core";
import {
  abandonPriorAttempts,
  acquireLease,
  CONSUMER_LEASE,
  contractOf,
  familyOf,
  getJobMode,
  invalidateAfterJob,
  isJobType,
  type JobMode,
  LANE_CONCURRENCY,
  LANES,
  LEASE_RENEW_MS,
  LEASE_TTL_MS,
  type Lease,
  markRunDead,
  parseEnvelope,
  releaseLease,
  renewLease,
  unitKey,
} from "@ma/jobs";
import { DEAD_QUEUE, ensureQueues } from "@ma/jobs/queue";
import type { PgBoss } from "pg-boss";
import { closeWorkerContext, type WorkerContext } from "./context.js";
import { executeJob } from "./execute.js";
import { HANDLERS } from "./handlers/index.js";
import { reconcile } from "./handlers/ops.js";
import { DEAD_METRIC } from "./metrics.js";
import { createBoss, createLedgerPort, createRetryPort } from "./queue.js";
import { clearSchedules, registerSchedules } from "./schedules.js";

const MODE_POLL_MS = 30_000;
const METRICS_FLUSH_MS = MINUTE;
const POLLING_INTERVAL_SECONDS = 5;
const HARD_EXIT_MS = 115_000;
const ABORT_BEFORE_DRAIN_END_MS = 10_000;

export class Consumer {
  private readonly ownerId = randomUUID();
  private readonly stopController = new AbortController();
  private readonly standby = new AbortController();
  private lease: Lease | null = null;
  private boss: PgBoss | null = null;
  private mode: JobMode | null = null;
  private consuming = false;
  private stopping: Promise<void> | null = null;
  private timers: NodeJS.Timeout[] = [];
  private lastRenewal = 0;
  exitCode = 0;

  constructor(
    private readonly ctx: WorkerContext,
    private readonly onFatal: (reason: string) => void,
  ) {}

  async run(): Promise<void> {
    const log = this.ctx.logger;
    while (!this.lease && !this.standby.signal.aborted) {
      this.lease = await acquireLease(this.ctx.db, CONSUMER_LEASE, this.ownerId);
      if (this.lease) break;
      log.info({ ownerId: this.ownerId }, "consumer lease held elsewhere; standing by");
      await sleep(LEASE_RENEW_MS, undefined, { signal: this.standby.signal }).catch(
        () => undefined,
      );
    }
    if (!this.lease) return;
    this.lastRenewal = Date.now();
    log.info(
      { ownerId: this.ownerId, generation: this.lease.generation },
      "consumer lease acquired",
    );
    this.every(LEASE_RENEW_MS, () => this.renew());
    this.every(METRICS_FLUSH_MS, () => this.ctx.metrics.flush());

    const boss = createBoss(this.ctx.config.DATABASE_URL, {
      schedule: this.ctx.env.WORKER_SCHEDULES,
    });
    boss.on("error", (err: unknown) => log.error({ err }, "pg-boss error"));
    this.boss = boss;
    await boss.start();
    await ensureQueues(boss);
    const abandoned = await abandonPriorAttempts(this.ctx.db, this.lease);
    const reconciled = await reconcile(this.ctx.db);
    log.info({ abandoned, reconciled }, "startup reconcile finished");
    await this.ctx.metrics.flush();
    await this.syncMode();
    this.every(MODE_POLL_MS, () => this.syncMode());
  }

  private every(ms: number, fn: () => Promise<unknown>): void {
    const timer = setInterval(() => {
      fn().catch((err: unknown) => this.ctx.logger.warn({ err }, "periodic task failed"));
    }, ms);
    timer.unref();
    this.timers.push(timer);
  }

  private async renew(): Promise<void> {
    const lease = this.lease;
    if (!lease) return;
    let held: boolean;
    try {
      held = await renewLease(this.ctx.db, lease);
    } catch (err) {
      this.ctx.logger.warn({ err }, "lease renewal errored");
      held = Date.now() - this.lastRenewal < LEASE_TTL_MS - LEASE_RENEW_MS;
    }
    if (held) {
      this.lastRenewal = Date.now();
      return;
    }
    this.ctx.logger.error({ generation: lease.generation }, "consumer lease lost; aborting work");
    this.lease = null;
    this.exitCode = 1;
    this.stopController.abort();
    this.onFatal("lease lost");
  }

  private async syncMode(): Promise<void> {
    if (this.stopping || !this.boss) return;
    const mode = await getJobMode(this.ctx.db);
    if (mode === this.mode) return;
    this.ctx.logger.info({ from: this.mode, to: mode }, "job mode changed");
    this.mode = mode;
    if (mode === "worker") await this.startConsuming();
    else await this.stopConsuming();
    if (mode === "worker" && this.ctx.env.WORKER_SCHEDULES) {
      this.ctx.logger.info(await registerSchedules(this.boss), "schedules registered");
    } else {
      const removed = await clearSchedules(this.boss);
      if (removed) this.ctx.logger.info({ removed }, "schedules cleared");
    }
  }

  private async startConsuming(): Promise<void> {
    const boss = this.boss;
    if (!boss || this.consuming) return;
    this.consuming = true;
    const deps = {
      ctx: this.ctx,
      handlers: HANDLERS,
      ledger: createLedgerPort(this.ctx.db, boss),
      retry: createRetryPort(boss),
      lease: () => this.lease,
      stop: this.stopController.signal,
      metrics: this.ctx.metrics,
      invalidate: (family: string) => invalidateAfterJob(this.ctx, family),
      logger: this.ctx.logger,
    };
    for (const lane of LANES) {
      await boss.work(
        lane,
        {
          localConcurrency: LANE_CONCURRENCY[lane],
          batchSize: 1,
          pollingIntervalSeconds: POLLING_INTERVAL_SECONDS,
        },
        async (jobs) => {
          for (const job of jobs) await executeJob(deps, job);
        },
      );
    }
    await boss.work(
      DEAD_QUEUE,
      { localConcurrency: 1, batchSize: 1, pollingIntervalSeconds: POLLING_INTERVAL_SECONDS },
      async (jobs) => {
        for (const job of jobs) await this.onDeadLetter(job.data);
      },
    );
  }

  private async stopConsuming(): Promise<void> {
    const boss = this.boss;
    if (!boss || !this.consuming) return;
    this.consuming = false;
    for (const name of [...LANES, DEAD_QUEUE]) await boss.offWork(name, { wait: true });
  }

  private async onDeadLetter(data: unknown): Promise<void> {
    const env = parseEnvelope(data);
    if (!isJobType(env.type)) return;
    const error = "queue retries exhausted (worker crash or expiry)";
    const target =
      env.runId !== null
        ? { runId: env.runId }
        : {
            jobType: env.type,
            unitKey: unitKey(env.type, env.payload as never),
            campaignId: env.campaignId,
          };
    if (await markRunDead(this.ctx.db, target, error)) {
      this.ctx.metrics.count(DEAD_METRIC);
      this.ctx.logger.error({ job: env.type, runId: env.runId }, "job dead-lettered");
      const family = familyOf(env.type);
      if (family && contractOf(env.type).kind === "unit")
        await invalidateAfterJob(this.ctx, family);
    }
  }

  shutdown(reason: string): Promise<void> {
    this.stopping ??= this.drain(reason);
    return this.stopping;
  }

  private async drain(reason: string): Promise<void> {
    const log = this.ctx.logger;
    log.info({ reason }, "worker stopping");
    const hardExit = setTimeout(() => {
      log.error("drain exceeded hard limit; exiting");
      process.exit(this.exitCode || 1);
    }, HARD_EXIT_MS);
    hardExit.unref();
    this.standby.abort();
    for (const t of this.timers) clearInterval(t);
    const drainMs = this.ctx.env.WORKER_DRAIN_MS;
    const abortTimer = setTimeout(
      () => this.stopController.abort(),
      Math.max(0, drainMs - ABORT_BEFORE_DRAIN_END_MS),
    );
    try {
      if (this.boss) await this.boss.stop({ graceful: true, timeout: drainMs, close: true });
    } catch (err) {
      log.error({ err }, "pg-boss stop failed");
    } finally {
      clearTimeout(abortTimer);
    }
    if (this.lease) await releaseLease(this.ctx.db, this.lease).catch(() => false);
    await this.ctx.metrics.flush().catch(() => undefined);
    await closeWorkerContext(this.ctx).catch(() => undefined);
    clearTimeout(hardExit);
    log.info({ reason }, "worker stopped");
  }
}
