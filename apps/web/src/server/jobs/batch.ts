import { DeadlineExceededError, mapLimit } from "@ma/core";
import { companySync, sql } from "@ma/db";
import type { AppContext } from "../context";
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

export async function universeIds(ctx: AppContext, indexCode: string): Promise<number[]> {
  const rows = await ctx.db.execute<{ id: number }>(sql`
    select c.id from companies c
    join index_constituents ic on ic.company_id = c.id
    join indices i on i.id = ic.index_id and i.code = ${indexCode}
    where c.listed
    order by c.market_cap_cr desc nulls last`);
  return rows.map((r) => r.id);
}

export async function pickBatch(
  ctx: AppContext,
  job: string,
  indexCode: string,
  limit: number,
  opts: { maxAgeMs?: number; where?: ReturnType<typeof sql> } = {},
): Promise<number[]> {
  const maxAge = opts.maxAgeMs ?? 0;
  const rows = await ctx.db.execute<{ id: number }>(sql`
    select c.id from companies c
    join index_constituents ic on ic.company_id = c.id
    join indices i on i.id = ic.index_id and i.code = ${indexCode}
    left join company_sync s on s.company_id = c.id and s.job = ${job}
    where c.listed
      and (s.failures is null or s.failures < 5 or s.attempted_at < now() - interval '6 hours')
      and (${maxAge} = 0 or s.synced_at is null or s.synced_at < now() - (${maxAge} * interval '1 millisecond'))
      ${opts.where ? sql`and (${opts.where})` : sql``}
    order by s.synced_at nulls first, c.market_cap_cr desc nulls last
    limit ${limit}`);
  return rows.map((r) => r.id);
}

export async function markSynced(ctx: AppContext, job: string, companyId: number): Promise<void> {
  await ctx.db
    .insert(companySync)
    .values({
      companyId,
      job,
      syncedAt: new Date(),
      attemptedAt: new Date(),
      failures: 0,
      error: null,
    })
    .onConflictDoUpdate({
      target: [companySync.companyId, companySync.job],
      set: { syncedAt: new Date(), attemptedAt: new Date(), failures: 0, error: null },
    });
}

export async function markFailed(
  ctx: AppContext,
  job: string,
  companyId: number,
  err: unknown,
): Promise<void> {
  const error = (err instanceof Error ? err.message : String(err)).slice(0, 500);
  await ctx.db
    .insert(companySync)
    .values({ companyId, job, attemptedAt: new Date(), failures: 1, error })
    .onConflictDoUpdate({
      target: [companySync.companyId, companySync.job],
      set: { attemptedAt: new Date(), failures: sql`${companySync.failures} + 1`, error },
    });
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
      await markSynced(ctx, name, id);
      return r;
    } catch (err) {
      if (err instanceof DeadlineExceededError) {
        skipped++;
        return null;
      }
      errors.push(err);
      ctx.logger.warn({ job: name, companyId: id, err }, "company sync failed");
      await markFailed(ctx, name, id, err);
      return null;
    }
  });
  if (ids.length > 0 && errors.length === ids.length)
    throw new Error(`all ${ids.length} items failed: ${String(errors[0])}`);
  return { items: ids.length, failed: errors.length, skipped, ...sumStats(results) };
}
