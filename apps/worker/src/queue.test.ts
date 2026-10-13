import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { closeDb, createDb, type Db, sql } from "@ma/db";
import {
  acquireLease,
  ensureRun,
  LEASE_RENEW_MS,
  type Lease,
  LeaseLostError,
  releaseLease,
  renewLease,
  startAttempt,
} from "@ma/jobs";
import { ENQUEUE_BATCH, ensureQueues } from "@ma/jobs/queue";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FanoutCompletion } from "./execute.js";
import { canCreateSchema, createBoss, createLedgerPort } from "./queue.js";

const url = process.env.DATABASE_URL_TEST;

describe.skipIf(!url)("completeFanout (DATABASE_URL_TEST)", () => {
  let db: Db;
  let boss: PgBoss;
  let lease: Lease;
  const tag = `test-${randomUUID().slice(0, 8)}`;
  const base = 900_000_000 + Math.floor(Math.random() * 1_000_000);
  const children = [
    { type: "prices.sync" as const, payload: { companyId: base } },
    { type: "prices.sync" as const, payload: { companyId: base + 1 } },
  ];

  beforeAll(async () => {
    db = createDb(url ?? "", 2);
    boss = createBoss(url ?? "", {
      schedule: false,
      supervise: false,
      createSchema: await canCreateSchema(db),
    });
    await boss.start();
    await ensureQueues(boss);
    lease = (await acquireLease(db, `${tag}-lease`, randomUUID(), 60_000)) as Lease;
  });

  afterAll(async () => {
    const campaigns = sql`(select id from ingest_runs where source = ${tag})`;
    await db.execute(sql`delete from pgboss.job where (data->>'campaignId')::int in ${campaigns}`);
    await db.execute(sql`delete from job_runs where campaign_id in ${campaigns}`);
    await db.execute(sql`delete from job_runs where unit_key = ${tag}`);
    await db.execute(sql`delete from ingest_runs where source = ${tag}`);
    await db.execute(sql`delete from worker_leases where name like ${`${tag}-%`}`);
    await boss.stop({ graceful: false, close: true });
    await closeDb(db);
  });

  async function attempt(
    n: number,
    owner = lease,
    kids: FanoutCompletion["children"] = children,
  ): Promise<FanoutCompletion> {
    const runId = await ensureRun(db, {
      type: "prices.fanout",
      unitKey: tag,
      campaignId: null,
      lane: "control",
      payload: {},
    });
    const attemptId = await startAttempt(db, {
      runId,
      attempt: n,
      deadlineAt: new Date(Date.now() + 60_000),
      queueJobId: null,
      lease: owner,
    });
    return {
      runId,
      attemptId: attemptId ?? 0,
      jobType: "prices.fanout",
      campaignId: null,
      outcome: "succeeded",
      error: null,
      metrics: { children: kids.length },
      durationMs: 5,
      lease: owner,
      source: tag,
      children: kids,
      queueJobId: "",
    };
  }

  const count = async (query: ReturnType<typeof sql>) =>
    Number((await db.execute<{ n: number }>(query))[0]?.n);

  it("commits the campaign, children and parent together and reuses them on replay", async () => {
    const port = createLedgerPort(db, boss);
    const queueJobId = randomUUID();
    const first = await port.completeFanout({ ...(await attempt(1)), queueJobId });
    expect(first).toMatchObject({ enqueued: 2, replayed: false });

    const replay = await port.completeFanout({ ...(await attempt(2)), queueJobId });
    expect(replay).toEqual({ campaignId: first.campaignId, enqueued: 2, replayed: true });

    expect(await count(sql`select count(*) as n from ingest_runs where source = ${tag}`)).toBe(1);
    expect(
      await count(sql`select count(*) as n from job_runs where campaign_id = ${first.campaignId}`),
    ).toBe(2);
    expect(
      await count(
        sql`select count(*) as n from pgboss.job where (data->>'campaignId')::int = ${first.campaignId}`,
      ),
    ).toBe(2);
    expect(
      await count(
        sql`select count(*) as n from job_runs where unit_key = ${tag} and status = 'succeeded'`,
      ),
    ).toBe(1);
  });

  it(
    "batches a large fan-out and never blocks lease renewal, even past LEASE_RENEW_MS",
    async () => {
      const own = (await acquireLease(db, `${tag}-renew`, randomUUID(), 60_000)) as Lease;
      const renewDb = createDb(url ?? "", 1);
      await renewDb.execute(sql`set lock_timeout = '2s'`);
      let inserts = 0;
      const slowBoss = {
        insert: async (...args: Parameters<PgBoss["insert"]>) => {
          inserts++;
          if (inserts === 1) await sleep(LEASE_RENEW_MS + 500);
          return boss.insert(...args);
        },
      } as unknown as PgBoss;
      const many = Array.from({ length: ENQUEUE_BATCH * 2 + 50 }, (_, i) => ({
        type: "prices.sync" as const,
        payload: { companyId: base + 10 + i },
      }));
      try {
        const input = await attempt(4, own, many);
        let done = false;
        const fanout = createLedgerPort(db, slowBoss)
          .completeFanout({ ...input, queueJobId: randomUUID() })
          .finally(() => {
            done = true;
          });
        const renewals: Array<{ ok: boolean; ms: number }> = [];
        while (!done) {
          const t0 = Date.now();
          renewals.push({ ok: await renewLease(renewDb, own, 60_000), ms: Date.now() - t0 });
          await sleep(1_000);
        }
        const result = await fanout;
        expect(result.enqueued).toBe(many.length);
        expect(inserts).toBe(3);
        expect(renewals.length).toBeGreaterThanOrEqual(10);
        expect(renewals.every((r) => r.ok && r.ms < 2_000)).toBe(true);
      } finally {
        await closeDb(renewDb);
      }
    },
    LEASE_RENEW_MS * 3,
  );

  it("rolls the whole fan-out back when the lease is gone", async () => {
    const port = createLedgerPort(db, boss);
    const queueJobId = randomUUID();
    const input = await attempt(3);
    await releaseLease(db, lease);
    await expect(port.completeFanout({ ...input, queueJobId })).rejects.toBeInstanceOf(
      LeaseLostError,
    );
    expect(
      await count(sql`select count(*) as n from ingest_runs where parent_job_id = ${queueJobId}`),
    ).toBe(0);
    expect(
      await count(
        sql`select count(*) as n from job_runs where unit_key = ${tag} and status = 'running'`,
      ),
    ).toBe(1);
  });
});
