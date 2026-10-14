import { randomUUID } from "node:crypto";
import { closeDb, createDb, type Db, sql } from "@ma/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "../context";
import { jobsSummary } from "./ops";

const url = process.env.DATABASE_URL_TEST;

describe.skipIf(!url)("ops jobs summary (DATABASE_URL_TEST)", () => {
  let db: Db;
  const tag = `ops-${randomUUID().slice(0, 8)}`;
  const jobType = `${tag}.unit`;
  const daysAgo = (days: number) => sql`now() - (${days} * interval '1 day')`;

  async function run(status: string, createdDays: number, finishedDays: number | null) {
    await db.execute(sql`
      insert into job_runs (job_type, unit_key, lane, payload, status, created_at, finished_at)
      values (${jobType}, ${randomUUID()}, 'compute', '{}'::jsonb, ${status}::job_status,
        ${daysAgo(createdDays)}, ${finishedDays === null ? null : daysAgo(finishedDays)})`);
  }

  beforeAll(async () => {
    db = createDb(url ?? "", 2);
    await run("deferred", 3, null);
    await run("succeeded", 3, 0);
    await run("succeeded", 3, 2);
    await run("queued", 0, null);
  });

  afterAll(async () => {
    await db.execute(sql`delete from job_runs where job_type = ${jobType}`);
    await closeDb(db);
  });

  it("keeps outstanding and recently finished runs and drops stale ones", async () => {
    const summary = await jobsSummary({ db } as AppContext);
    const mine = summary.runs.filter((r) => r.jobType === jobType);
    expect(mine.map((r) => [r.status, r.runs])).toEqual([
      ["queued", 1],
      ["succeeded", 1],
      ["deferred", 1],
    ]);
    expect(["paused", "worker"]).toContain(summary.mode);
  });
});
