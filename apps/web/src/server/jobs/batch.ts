import { DeadlineExceededError, mapLimit } from "@ma/core";
import { markFailed, markSynced } from "@ma/jobs";
import type { JobRun, JobStats } from "./run";

type ItemStats = JobStats | number | null | undefined;

export function sumStats(results: ItemStats[]): JobStats {
  const out: JobStats = {};
  for (const r of results) {
    if (r == null) continue;
    if (typeof r === "number") out.total = (out.total ?? 0) + r;
    else for (const [k, v] of Object.entries(r)) out[k] = (out[k] ?? 0) + v;
  }
  return out;
}

export async function forEachCompany(
  run: JobRun,
  ids: number[],
  concurrency: number,
  fn: (id: number) => Promise<ItemStats>,
  opts: { reserveMs?: number } = {},
): Promise<JobStats> {
  const { ctx, name } = run;
  const reserve = opts.reserveMs ?? 20_000;
  const errors: unknown[] = [];
  let skipped = 0;
  const results = await mapLimit(ids, concurrency, async (id) => {
    if (run.expired(reserve)) {
      skipped++;
      return null;
    }
    try {
      const r = await fn(id);
      await markSynced(ctx.db, name, id);
      return r;
    } catch (err) {
      if (err instanceof DeadlineExceededError) {
        skipped++;
        return null;
      }
      errors.push(err);
      ctx.logger.warn({ job: name, companyId: id, err }, "company sync failed");
      await markFailed(ctx.db, name, id, err);
      return null;
    }
  });
  if (ids.length > 0 && errors.length === ids.length)
    throw new Error(`all ${ids.length} items failed: ${String(errors[0])}`);
  return { items: ids.length, failed: errors.length, skipped, ...sumStats(results) };
}
