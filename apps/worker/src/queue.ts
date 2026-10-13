import { type Db, sql } from "@ma/db";
import {
  createCampaign,
  ensureRun,
  finishAttempt,
  type Lease,
  recordRootOutcome,
  setCampaignTotal,
  startAttempt,
} from "@ma/jobs";
import { enqueue, PG_BOSS_SCHEMA } from "@ma/jobs/queue";
import { PgBoss } from "pg-boss";
import { QUEUE_POOL_MAX, queueConnection } from "./context.js";
import { LeaseLostError, type LedgerPort, type RetryPort } from "./execute.js";

export function createBoss(
  databaseUrl: string,
  opts: { schedule: boolean; supervise?: boolean },
): PgBoss {
  return new PgBoss({
    ...queueConnection(databaseUrl),
    max: QUEUE_POOL_MAX,
    schema: PG_BOSS_SCHEMA,
    application_name: "ma-worker-queue",
    migrate: true,
    schedule: opts.schedule,
    supervise: opts.supervise ?? true,
  });
}

async function assertLease(tx: Pick<Db, "execute">, lease: Lease): Promise<void> {
  const rows = await tx.execute(sql`
    select 1 from worker_leases
    where name = ${lease.name} and owner_id = ${lease.ownerId}
      and generation = ${lease.generation} and leased_until > now()
    for share`);
  if (rows.length === 0) throw new LeaseLostError();
}

export function createLedgerPort(db: Db, boss: PgBoss): LedgerPort {
  return {
    ensureRun: (input) => ensureRun(db, input),
    startAttempt: (input) => startAttempt(db, input),
    finishAttempt: (input) => finishAttempt(db, input),
    recordRoot: (outcome) => recordRootOutcome(db, outcome),
    spawnChildren: (source, children, lease) =>
      db.transaction(async (tx) => {
        await assertLease(tx, lease);
        const campaignId = await createCampaign(tx, source);
        let enqueued = 0;
        for (const child of children) {
          const r = await enqueue(
            boss,
            {
              type: child.type,
              payload: child.payload as never,
              campaignId,
              ...(child.priority !== undefined ? { priority: child.priority } : {}),
            },
            tx,
          );
          if (r.jobId) enqueued++;
        }
        await setCampaignTotal(tx, campaignId, enqueued, {
          children: children.length,
          deduplicated: children.length - enqueued,
        });
        return { campaignId, enqueued };
      }),
  };
}

export function createRetryPort(boss: PgBoss): RetryPort {
  return { send: (request) => enqueue(boss, request) };
}
