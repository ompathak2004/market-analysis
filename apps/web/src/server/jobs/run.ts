import { randomUUID } from "node:crypto";
import { withDeadline } from "@ma/core";
import { eq, ingestRuns } from "@ma/db";
import type { AppContext } from "../context";
import { invalidateAfterJob } from "./invalidation";

const RELEASE_IF_OWNER = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) end return 0`;

export type JobStats = Record<string, number>;

export interface JobRun {
  readonly ctx: AppContext;
  readonly name: string;
  readonly deadline: number;
  readonly signal: AbortSignal;
  remainingMs(): number;
  expired(reserveMs?: number): boolean;
}

export interface JobDef {
  name: string;
  budgetMs: number;
  run: (run: JobRun) => Promise<JobStats>;
}

export type JobOutcome =
  | { status: "ok"; runId: number; ms: number; stats: JobStats }
  | { status: "skipped"; reason: "locked" | "disabled" }
  | { status: "failed"; runId: number; ms: number; error: string };

export async function runJob(
  ctx: AppContext,
  name: string,
  budgetMs: number,
  fn: (run: JobRun) => Promise<JobStats>,
): Promise<JobOutcome> {
  const lockKey = `job:lock:${name}`;
  const token = randomUUID();
  const acquired = await ctx.redis.set(lockKey, token, "PX", budgetMs + 60_000, "NX");
  if (!acquired) return { status: "skipped", reason: "locked" };

  const [row] = await ctx.db
    .insert(ingestRuns)
    .values({ source: name })
    .returning({ id: ingestRuns.id });
  const runId = row?.id ?? 0;
  const started = Date.now();
  const deadline = started + budgetMs;
  ctx.logger.info({ job: name, budgetMs }, "job started");
  try {
    const stats = await withDeadline(deadline, (signal) =>
      fn({
        ctx,
        name,
        deadline,
        signal,
        remainingMs: () => deadline - Date.now(),
        expired: (reserveMs = 0) => Date.now() + reserveMs >= deadline,
      }),
    );
    const ms = Date.now() - started;
    await ctx.db
      .update(ingestRuns)
      .set({ status: "succeeded", finishedAt: new Date(), stats })
      .where(eq(ingestRuns.id, runId));
    ctx.logger.info({ job: name, ms, stats }, "job finished");
    return { status: "ok", runId, ms, stats };
  } catch (err) {
    const ms = Date.now() - started;
    const error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    await ctx.db
      .update(ingestRuns)
      .set({ status: "failed", finishedAt: new Date(), error })
      .where(eq(ingestRuns.id, runId));
    ctx.logger.error({ job: name, ms, err }, "job failed");
    return { status: "failed", runId, ms, error };
  } finally {
    await invalidateAfterJob(ctx, name);
    await ctx.redis.eval(RELEASE_IF_OWNER, 1, lockKey, token).catch(() => undefined);
  }
}
