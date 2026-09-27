import { randomUUID } from "node:crypto";
import type { RedisClient } from "@ma/cache";
import type { Logger } from "@ma/core";
import { type Db, eq, ingestRuns } from "@ma/db";

export interface Job {
  name: string;
  everyMs: number;
  run: () => Promise<Record<string, number>>;
  activeHoursIst?: [start: number, end: number];
}

const IST_OFFSET_MS = 5.5 * 3_600_000;
const RELEASE_IF_OWNER = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) end return 0`;
const RENEW_IF_OWNER = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) end return 0`;

export function istHour(now = new Date()): number {
  return new Date(now.getTime() + IST_OFFSET_MS).getUTCHours();
}

export class Scheduler {
  private timers: NodeJS.Timeout[] = [];
  private stopped = false;

  constructor(
    private readonly db: Db,
    private readonly redis: RedisClient,
    private readonly logger: Logger,
  ) {}

  start(jobs: Job[]): void {
    for (const [i, job] of jobs.entries()) {
      const tick = () =>
        void this.runOnce(job).finally(() => this.schedule(job, job.everyMs, tick));
      this.schedule(job, 2_000 + i * 5_000, tick);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
  }

  private schedule(_job: Job, delayMs: number, fn: () => void): void {
    if (this.stopped) return;
    const t = setTimeout(fn, delayMs);
    t.unref();
    this.timers.push(t);
  }

  async runOnce(job: Job): Promise<void> {
    if (job.activeHoursIst) {
      const h = istHour();
      const [start, end] = job.activeHoursIst;
      if (h < start || h >= end) return;
    }
    const lockKey = `job:lock:${job.name}`;
    const token = randomUUID();
    const ttlMs = Math.max(job.everyMs, 60_000);
    const acquired = await this.redis.set(lockKey, token, "PX", ttlMs, "NX");
    if (!acquired) return;
    const release = () => this.redis.eval(RELEASE_IF_OWNER, 1, lockKey, token);
    const lastKey = `job:last:${job.name}`;
    const last = Number((await this.redis.get(lastKey)) ?? 0);
    if (Date.now() - last < job.everyMs * 0.9) {
      await release();
      return;
    }
    const lease = setInterval(() => {
      void this.redis.eval(RENEW_IF_OWNER, 1, lockKey, token, ttlMs.toString());
    }, ttlMs / 3);
    lease.unref();

    const [run] = await this.db
      .insert(ingestRuns)
      .values({ source: job.name })
      .returning({ id: ingestRuns.id });
    const started = Date.now();
    this.logger.info({ job: job.name }, "job started");
    try {
      const stats = await job.run();
      await this.db
        .update(ingestRuns)
        .set({ status: "succeeded", finishedAt: new Date(), stats })
        .where(eq(ingestRuns.id, run?.id ?? -1));
      await this.redis.set(lastKey, Date.now().toString());
      this.logger.info({ job: job.name, ms: Date.now() - started, ...stats }, "job finished");
    } catch (err) {
      await this.db
        .update(ingestRuns)
        .set({
          status: "failed",
          finishedAt: new Date(),
          error: err instanceof Error ? err.message.slice(0, 2000) : String(err),
        })
        .where(eq(ingestRuns.id, run?.id ?? -1));
      this.logger.error({ job: job.name, err }, "job failed");
    } finally {
      clearInterval(lease);
      await release();
    }
  }
}
