import { companySync, type Db, fencedTransaction, sql } from "@ma/db";
import { assertFence, type Fence } from "./lease.js";

type SQL = ReturnType<typeof sql>;

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
  opts: { maxAgeMs?: number; where?: SQL; due?: SQL } = {},
): Promise<number[]> {
  const maxAge = opts.maxAgeMs ?? 0;
  const rows = await db.execute<{ id: number }>(sql`
    select c.id from companies c
    join index_constituents ic on ic.company_id = c.id
    join indices i on i.id = ic.index_id and i.code = ${indexCode}
    left join company_sync s on s.company_id = c.id and s.job = ${job}
    where c.listed
      and (s.failures is null or s.failures < 5 or s.attempted_at < now() - interval '6 hours')
      and (${maxAge} = 0 or s.synced_at is null
        or s.synced_at < now() - (${maxAge} * interval '1 millisecond')
        ${opts.due ? sql`or (${opts.due})` : sql``})
      ${opts.where ? sql`and (${opts.where})` : sql``}
    order by s.synced_at nulls first, c.market_cap_cr desc nulls last
    limit ${limit}`);
  return rows.map((r) => Number(r.id));
}

export async function pickBriefBatch(db: Db, indexCode: string, limit: number): Promise<number[]> {
  const rows = await db.execute<{ id: number }>(sql`
    select c.id, b.generated_at from companies c
    join index_constituents ic on ic.company_id = c.id
    join indices i on i.id = ic.index_id and i.code = ${indexCode}
    left join lateral (
      select generated_at from insights
      where company_id = c.id and kind = 'company_brief' and superseded_at is null
      order by generated_at desc limit 1
    ) b on true
    left join company_sync s on s.company_id = c.id and s.job = 'insights'
    where c.listed
      and (exists (select 1 from prices_daily p where p.company_id = c.id and p.date > current_date - 10)
        or exists (select 1 from fundamentals f where f.company_id = c.id))
      and (s.failures is null or s.failures < 3 or s.attempted_at < now() - interval '6 hours')
      and (b.generated_at is null
        or s.synced_at is null
        or s.synced_at < now() - interval '20 hours'
        or exists (select 1 from announcements a where a.company_id = c.id
          and a.materiality = 'high' and a.created_at > s.synced_at))
    order by (b.generated_at is null) desc, s.synced_at asc nulls first, c.market_cap_cr desc nulls last
    limit ${limit}`);
  return rows.map((r) => Number(r.id));
}

export async function markSynced(
  db: Db,
  job: string,
  companyId: number,
  fence?: Fence,
): Promise<void> {
  const now = new Date();
  await fencedTransaction(db, async (tx) => {
    await tx
      .insert(companySync)
      .values({ companyId, job, syncedAt: now, attemptedAt: now, failures: 0, error: null })
      .onConflictDoUpdate({
        target: [companySync.companyId, companySync.job],
        set: { syncedAt: now, attemptedAt: now, failures: 0, error: null },
      });
    if (fence) await assertFence(tx, fence);
  });
}

export async function markFailed(
  db: Db,
  job: string,
  companyId: number,
  err: unknown,
): Promise<void> {
  const error = (err instanceof Error ? err.message : String(err)).slice(0, 500);
  await fencedTransaction(db, (tx) =>
    tx
      .insert(companySync)
      .values({ companyId, job, attemptedAt: new Date(), failures: 1, error })
      .onConflictDoUpdate({
        target: [companySync.companyId, companySync.job],
        set: { attemptedAt: new Date(), failures: sql`${companySync.failures} + 1`, error },
      }),
  );
}
