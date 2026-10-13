import { AppError } from "@ma/core";
import { type Db, sql } from "@ma/db";

export const CONSUMER_LEASE = "consumer";
export const LEASE_TTL_MS = 45_000;
export const LEASE_RENEW_MS = 10_000;

export interface Lease {
  name: string;
  ownerId: string;
  generation: number;
}

export interface Fence {
  lease: Lease;
  attemptId?: number;
}

export class LeaseLostError extends AppError {
  constructor() {
    super("consumer lease lost; refusing to commit", "lease_lost", 503);
  }
}

type Executor = Pick<Db, "execute">;

export async function assertFence(tx: Executor, fence: Fence): Promise<void> {
  const { lease, attemptId } = fence;
  const rows = await tx.execute(sql`
    select 1 from worker_leases
    where name = ${lease.name} and owner_id = ${lease.ownerId}
      and generation = ${lease.generation} and leased_until > now()
    for share`);
  if (rows.length === 0) throw new LeaseLostError();
  if (attemptId === undefined) return;
  const open = await tx.execute(sql`
    select 1 from job_attempts where id = ${attemptId} and finished_at is null for share`);
  if (open.length === 0) throw new LeaseLostError();
}

export async function acquireLease(
  db: Executor,
  name: string,
  ownerId: string,
  ttlMs = LEASE_TTL_MS,
): Promise<Lease | null> {
  const rows = await db.execute<{ generation: string | number }>(sql`
    insert into worker_leases (name, owner_id, generation, leased_until, heartbeat_at)
    values (${name}, ${ownerId}, 1, now() + (${ttlMs} * interval '1 millisecond'), now())
    on conflict (name) do update
      set owner_id = excluded.owner_id,
          generation = worker_leases.generation + 1,
          leased_until = excluded.leased_until,
          heartbeat_at = now()
      where worker_leases.leased_until < now() or worker_leases.owner_id = excluded.owner_id
    returning generation`);
  const row = rows[0];
  return row ? { name, ownerId, generation: Number(row.generation) } : null;
}

export async function renewLease(
  db: Executor,
  lease: Lease,
  ttlMs = LEASE_TTL_MS,
): Promise<boolean> {
  const rows = await db.execute(sql`
    update worker_leases
      set leased_until = now() + (${ttlMs} * interval '1 millisecond'), heartbeat_at = now()
    where name = ${lease.name} and owner_id = ${lease.ownerId} and generation = ${lease.generation}
    returning name`);
  return rows.length > 0;
}

export async function releaseLease(db: Executor, lease: Lease): Promise<boolean> {
  const rows = await db.execute(sql`
    update worker_leases set leased_until = now()
    where name = ${lease.name} and owner_id = ${lease.ownerId} and generation = ${lease.generation}
    returning name`);
  return rows.length > 0;
}

export async function holdsLease(db: Executor, lease: Lease): Promise<boolean> {
  const rows = await db.execute(sql`
    select 1 from worker_leases
    where name = ${lease.name} and owner_id = ${lease.ownerId} and generation = ${lease.generation}
      and leased_until > now()`);
  return rows.length > 0;
}
