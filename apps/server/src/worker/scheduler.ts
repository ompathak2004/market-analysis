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
    const acquired = await this.redis.set(
      lockKey,
      process.pid.toString(),
      "PX",
      Math.max(job.everyMs, 60_000),
      "NX",
    );
    if (!acquired) return;
    const lastKey = `job:last:${job.name}`;
    const last = Number((await this.redis.get(lastKey)) ?? 0);
    if (Date.now() - last < job.everyMs * 0.9) return;

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
      await this.redis.del(lockKey);
    }
  }
}
