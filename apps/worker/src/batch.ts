import { companySync, type Db, sql } from "@ma/db";

export type Metrics = Record<string, number>;

export function numericMetrics(value: unknown, prefix = ""): Metrics {
  const out: Metrics = {};
  if (value == null || typeof value !== "object") return out;
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === "number" && Number.isFinite(v)) out[`${prefix}${k}`] = v;
    else if (typeof v === "boolean") out[`${prefix}${k}`] = v ? 1 : 0;
  }
  return out;
}

export async function universeIds(db: Db, indexCode: string): Promise<number[]> {
  const rows = await db.execute<{ id: number }>(sql`
    select c.id from companies c
    join index_constituents ic on ic.company_id = c.id
    join indices i on i.id = ic.index_id and i.code = ${indexCode}
    where c.listed
    order by c.market_cap_cr desc nulls last`);
  return rows.map((r) => Number(r.id));
}

export async function pickBatch(
  db: Db,
  job: string,
  indexCode: string,
  limit: number,
  opts: { maxAgeMs?: number; where?: ReturnType<typeof sql> } = {},
): Promise<number[]> {
  const maxAge = opts.maxAgeMs ?? 0;
  const rows = await db.execute<{ id: number }>(sql`
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
  return rows.map((r) => Number(r.id));
}

export async function markSynced(db: Db, job: string, companyId: number): Promise<void> {
  const now = new Date();
  await db
    .insert(companySync)
    .values({ companyId, job, syncedAt: now, attemptedAt: now, failures: 0, error: null })
    .onConflictDoUpdate({
      target: [companySync.companyId, companySync.job],
      set: { syncedAt: now, attemptedAt: now, failures: 0, error: null },
    });
}

export async function markFailed(
  db: Db,
  job: string,
  companyId: number,
  err: unknown,
): Promise<void> {
  const error = (err instanceof Error ? err.message : String(err)).slice(0, 500);
  await db
    .insert(companySync)
    .values({ companyId, job, attemptedAt: new Date(), failures: 1, error })
    .onConflictDoUpdate({
      target: [companySync.companyId, companySync.job],
      set: { attemptedAt: new Date(), failures: sql`${companySync.failures} + 1`, error },
    });
}

export async function trackCompany<T>(
  db: Db,
  job: string,
  companyId: number,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    const result = await fn();
    await markSynced(db, job, companyId);
    return result;
  } catch (err) {
    await markFailed(db, job, companyId, err).catch(() => undefined);
    throw err;
  }
}
