import { type Db, sql } from "@ma/db";
import {
  assertFence,
  createCampaign,
  ensureRun,
  findCampaign,
  finishAttempt,
  LeaseLostError,
  recordRootOutcome,
  setCampaignTotal,
  startAttempt,
  type Tx,
} from "@ma/jobs";
import { enqueue, enqueueMany, type ManyChild, PG_BOSS_SCHEMA } from "@ma/jobs/queue";
import { PgBoss } from "pg-boss";
import { QUEUE_POOL_MAX, queueConnection } from "./context.js";
import type { LedgerPort, RetryPort, SpawnResult } from "./execute.js";
import type { ChildJob } from "./registry.js";

export async function canCreateSchema(db: Db): Promise<boolean> {
  const rows = await db.execute<{ allowed: boolean }>(sql`
    select not exists (select 1 from pg_namespace where nspname = ${PG_BOSS_SCHEMA})
      and has_database_privilege(current_database(), 'CREATE') as allowed`);
  return rows[0]?.allowed === true;
}

export async function sessionLimits(
  db: Db,
): Promise<{ role: string; statementTimeout: string; lockTimeout: string; unbounded: boolean }> {
  const rows = await db.execute<{ role: string; statement_timeout: string; lock_timeout: string }>(
    sql`select current_user as role,
      current_setting('statement_timeout') as statement_timeout,
      current_setting('lock_timeout') as lock_timeout`,
  );
  const row = rows[0];
  const statementTimeout = row?.statement_timeout ?? "0";
  return {
    role: row?.role ?? "",
    statementTimeout,
    lockTimeout: row?.lock_timeout ?? "0",
    unbounded: statementTimeout === "0",
  };
}

export function createBoss(
  databaseUrl: string,
  opts: { schedule: boolean; supervise?: boolean; createSchema: boolean },
): PgBoss {
  return new PgBoss({
    ...queueConnection(databaseUrl),
    max: QUEUE_POOL_MAX,
    schema: PG_BOSS_SCHEMA,
    application_name: "ma-worker-queue",
    migrate: true,
    createSchema: opts.createSchema,
    schedule: opts.schedule,
    supervise: opts.supervise ?? true,
  });
}

async function spawn(
  tx: Tx,
  boss: PgBoss,
  source: string,
  children: ChildJob[],
  parentJobId: string,
): Promise<SpawnResult> {
  const campaignId = await createCampaign(tx, source, parentJobId);
  const enqueued = await enqueueMany(boss, campaignId, children as ManyChild[], tx);
  await setCampaignTotal(tx, campaignId, enqueued, {
    children: children.length,
    deduplicated: children.length - enqueued,
  });
  return { campaignId, enqueued, replayed: false };
}

export function createLedgerPort(db: Db, boss: PgBoss): LedgerPort {
  return {
    ensureRun: (input) => ensureRun(db, input),
    startAttempt: (input) => startAttempt(db, input),
    finishAttempt: (input) => finishAttempt(db, input),
    recordRoot: (outcome) => recordRootOutcome(db, outcome),
    completeFanout: ({ source, children, queueJobId, ...finish }) =>
      db.transaction(async (tx) => {
        const existing = await findCampaign(tx, queueJobId);
        const spawned = existing
          ? { ...existing, replayed: true }
          : await spawn(tx, boss, source, children, queueJobId);
        const metrics = {
          ...finish.metrics,
          enqueued: spawned.enqueued,
          campaignId: spawned.campaignId,
        };
        await assertFence(tx, { lease: finish.lease, attemptId: finish.attemptId });
        if (!(await finishAttempt(tx, { ...finish, metrics }))) throw new LeaseLostError();
        return spawned;
      }),
  };
}

export function createRetryPort(boss: PgBoss): RetryPort {
  return { send: (request) => enqueue(boss, request) };
}
