import { randomUUID } from "node:crypto";
import { closeDb, createDb, type Db, sql } from "@ma/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { acquireLease, holdsLease, type Lease, releaseLease, renewLease } from "./lease.js";
import {
  abandonPriorAttempts,
  createCampaign,
  ensureRun,
  finishAttempt,
  markRunDead,
  sanitizeError,
  setCampaignTotal,
  startAttempt,
} from "./ledger.js";

const url = process.env.DATABASE_URL_TEST;

describe("sanitizeError", () => {
  it("masks credentials", () => {
    const msg = sanitizeError(new Error("connect postgres://u:hunter2@db:5432/x?api_key=abc123"));
    expect(msg).not.toContain("hunter2");
    expect(msg).not.toContain("abc123");
  });
});

describe.skipIf(!url)("ledger and lease (DATABASE_URL_TEST)", () => {
  let db: Db;
  const tag = `test-${randomUUID().slice(0, 8)}`;
  const leaseName = `${tag}-lease`;
  const jobType = `${tag}.unit`;

  beforeAll(() => {
    db = createDb(url ?? "", 2);
  });

  afterAll(async () => {
    await db.execute(sql`delete from job_runs where job_type = ${jobType}`);
    await db.execute(sql`delete from job_daily_stats where job_type = ${jobType}`);
    await db.execute(sql`delete from ingest_runs where source = ${tag}`);
    await db.execute(sql`delete from worker_leases where name = ${leaseName}`);
    await closeDb(db);
  });

  async function runStatus(id: number): Promise<string | undefined> {
    const rows = await db.execute<{ status: string }>(
      sql`select status from job_runs where id = ${id}`,
    );
    return rows[0]?.status;
  }

  it("grants the lease to one owner and fences the previous generation", async () => {
    const a = await acquireLease(db, leaseName, randomUUID(), 60_000);
    expect(a).not.toBeNull();
    expect(await acquireLease(db, leaseName, randomUUID(), 60_000)).toBeNull();
    const lease = a as Lease;
    expect(await renewLease(db, lease, 60_000)).toBe(true);
    expect(await releaseLease(db, lease)).toBe(true);
    const b = await acquireLease(db, leaseName, randomUUID(), 60_000);
    expect(b?.generation).toBe(lease.generation + 1);
    expect(await holdsLease(db, lease)).toBe(false);
    expect(await renewLease(db, lease)).toBe(false);

    const runId = await ensureRun(db, {
      type: jobType,
      unitKey: `${jobType}:fenced`,
      campaignId: null,
      lane: "io",
      payload: {},
    });
    const fenced = await startAttempt(db, {
      runId,
      attempt: 1,
      deadlineAt: new Date(Date.now() + 60_000),
      queueJobId: null,
      lease,
    });
    expect(fenced).toBeNull();
    expect(await runStatus(runId)).toBe("queued");
    if (b) await releaseLease(db, b);
  });

  it("records attempts and settles campaigns", async () => {
    const lease = (await acquireLease(db, leaseName, randomUUID(), 60_000)) as Lease;
    const campaignId = await createCampaign(db, tag);
    const ids: number[] = [];
    for (const n of [1, 2]) {
      ids.push(
        await ensureRun(db, {
          type: jobType,
          unitKey: `${jobType}:${n}`,
          campaignId,
          lane: "io",
          payload: { n, apiKey: "secret" },
        }),
      );
    }
    await setCampaignTotal(db, campaignId, 2, {});
    expect(
      await ensureRun(db, {
        type: jobType,
        unitKey: `${jobType}:1`,
        campaignId,
        lane: "io",
        payload: {},
      }),
    ).toBe(ids[0]);

    const [first, second] = ids as [number, number];
    const attemptId = await startAttempt(db, {
      runId: first,
      attempt: 1,
      deadlineAt: new Date(Date.now() + 60_000),
      queueJobId: randomUUID(),
      lease,
    });
    expect(attemptId).not.toBeNull();
    expect(await runStatus(first)).toBe("running");
    const ok = await finishAttempt(db, {
      runId: first,
      attemptId: attemptId as number,
      jobType,
      campaignId,
      outcome: "succeeded",
      error: null,
      metrics: { rows: 3 },
      durationMs: 120,
      lease,
    });
    expect(ok).toBe(true);
    expect(await markRunDead(db, { runId: second }, "exhausted")).toBe(true);
    expect(await markRunDead(db, { runId: second }, "exhausted")).toBe(false);

    const campaign = await db.execute<{
      status: string;
      children_done: number;
      children_failed: number;
      error: string | null;
    }>(
      sql`select status, children_done, children_failed, error from ingest_runs where id = ${campaignId}`,
    );
    expect(campaign[0]).toMatchObject({
      status: "failed",
      children_done: 1,
      children_failed: 1,
      error: "1 of 2 children failed",
    });
    const stats = await db.execute<{ succeeded: number; dead: number }>(
      sql`select succeeded, dead from job_daily_stats where job_type = ${jobType}`,
    );
    expect(stats[0]).toMatchObject({ succeeded: 1, dead: 1 });
    const payload = await db.execute<{ payload: Record<string, unknown> }>(
      sql`select payload from job_runs where id = ${first}`,
    );
    expect(payload[0]?.payload).not.toHaveProperty("apiKey");
    await releaseLease(db, lease);
  });

  it("abandons attempts left running by an earlier generation", async () => {
    const old = (await acquireLease(db, leaseName, randomUUID(), 60_000)) as Lease;
    const runId = await ensureRun(db, {
      type: jobType,
      unitKey: `${jobType}:orphan`,
      campaignId: null,
      lane: "io",
      payload: {},
    });
    await startAttempt(db, {
      runId,
      attempt: 1,
      deadlineAt: new Date(Date.now() + 60_000),
      queueJobId: null,
      lease: old,
    });
    await releaseLease(db, old);
    const next = (await acquireLease(db, leaseName, randomUUID(), 60_000)) as Lease;
    expect(await abandonPriorAttempts(db, next)).toBeGreaterThanOrEqual(1);
    expect(await runStatus(runId)).toBe("abandoned");
    await releaseLease(db, next);
  });
});
