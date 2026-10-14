import { randomInt, randomUUID } from "node:crypto";
import { closeDb, createDb, type Db, sql, type Tx } from "@ma/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ABANDONED_TRANSIT, pruneRetention } from "./maintenance.js";

const url = process.env.DATABASE_URL_TEST;

class Rollback extends Error {}

async function rolledBack(db: Db, fn: (tx: Tx) => Promise<void>): Promise<void> {
  await db
    .transaction(async (tx) => {
      await fn(tx);
      throw new Rollback();
    })
    .catch((err: unknown) => {
      if (!(err instanceof Rollback)) throw err;
    });
}

const daysAgo = (days: number) => sql`now() - (${days} * interval '1 day')`;

describe.skipIf(!url)("pruneRetention (DATABASE_URL_TEST)", () => {
  let db: Db;
  const tag = `prune-${randomUUID().slice(0, 8)}`;

  beforeAll(() => {
    db = createDb(url ?? "", 2);
  });

  afterAll(async () => {
    await closeDb(db);
  });

  async function campaign(
    tx: Tx,
    source: string,
    status: "running" | "succeeded" | "failed",
    days: number,
  ): Promise<number> {
    const rows = await tx.execute<{ id: number }>(sql`
      insert into ingest_runs (source, status, started_at, finished_at, kind)
      values (${source}, ${status}, ${daysAgo(days)},
        ${status === "running" ? null : daysAgo(days)}, 'campaign')
      returning id`);
    return Number(rows[0]?.id);
  }

  async function existing(tx: Tx, table: string, ids: number[]): Promise<number[]> {
    const rows = await tx.execute<{ id: number }>(sql`
      select id from ${sql.identifier(table)} where id in (${sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `,
      )}) order by id`);
    return rows.map((r) => Number(r.id));
  }

  it("prunes expired rows and keeps live campaigns and recent facts", async () => {
    await rolledBack(db, async (tx) => {
      const oldOk = await campaign(tx, tag, "succeeded", 120);
      const busy = await campaign(tx, tag, "succeeded", 110);
      await tx.execute(sql`
        insert into job_runs (job_type, unit_key, campaign_id, lane, payload, status)
        values (${`${tag}.unit`}, 'x', ${busy}, 'compute', '{}'::jsonb, 'queued')`);
      const running = await campaign(tx, tag, "running", 120);
      const latestOk = await campaign(tx, tag, "succeeded", 100);
      const oldFailed = await campaign(tx, tag, "failed", 200);
      const recentFailed = await campaign(tx, tag, "failed", 120);
      const failedLatest = await campaign(tx, tag, "failed", 100);

      const mmsi = 990_000_000 + randomInt(9_000_000);
      await tx.execute(sql`
        insert into vessels (mmsi, first_seen_at, last_seen_at) values (${mmsi}, now(), now())`);
      const transit = async (enteredDays: number, leftDays: number | null) => {
        const rows = await tx.execute<{ id: number }>(sql`
          insert into chokepoint_transits (mmsi, chokepoint, entered_at, left_at, loiter_min)
          values (${mmsi}, ${tag}, ${daysAgo(enteredDays)},
            ${leftDays === null ? null : daysAgo(leftDays)}, 90)
          returning id`);
        return Number(rows[0]?.id);
      };
      const stale = await transit(40, null);
      const open = await transit(5, null);
      const oldTransit = await transit(201, 200);
      const keptTransit = await transit(101, 100);

      const event = async (days: number) => {
        const rows = await tx.execute<{ id: number }>(sql`
          insert into altdata_events (layer, kind, occurred_at, headline, detail, dedupe_key)
          values ('vessels', ${tag}, ${daysAgo(days)}, ${tag}, '{}'::jsonb, ${randomUUID()})
          returning id`);
        return Number(rows[0]?.id);
      };
      const oldEvent = await event(200);
      const keptEvent = await event(100);

      const insight = async (supersededDays: number | null) => {
        const rows = await tx.execute<{ id: number }>(sql`
          insert into insights (kind, model_version, model, input_hash, inputs, output, superseded_at)
          values (${tag}, 1, ${tag}, ${randomUUID()}, '{}'::jsonb, '{}'::jsonb,
            ${supersededDays === null ? null : daysAgo(supersededDays)})
          returning id`);
        return Number(rows[0]?.id);
      };
      const oldInsight = await insight(200);
      const keptInsight = await insight(100);
      const current = await insight(null);

      const usage = async (days: number, ok: boolean) => {
        const rows = await tx.execute<{ id: number }>(sql`
          insert into llm_usage (kind, model, prompt_tokens, completion_tokens, latency_ms, ok, created_at)
          values (${tag}, ${tag}, 100, 10, 500, ${ok}, ${daysAgo(days)}) returning id`);
        return Number(rows[0]?.id);
      };
      const usageOld = [await usage(120, true), await usage(120, true), await usage(120, false)];
      const usageNew = await usage(10, true);

      await tx.execute(sql`
        insert into altdata_coverage (layer, zone, day, windows, windows_with_data, messages, unique_ids)
        values (${tag}, 'old', (${daysAgo(500)})::date, 1, 1, 1, 1),
          (${tag}, 'new', (${daysAgo(10)})::date, 1, 1, 1, 1)`);

      const result = await pruneRetention(tx, { batch: 2 });
      expect(result.complete).toBe(1);

      expect(
        await existing(tx, "ingest_runs", [
          oldOk,
          busy,
          running,
          latestOk,
          oldFailed,
          recentFailed,
          failedLatest,
        ]),
      ).toEqual([busy, running, latestOk, recentFailed, failedLatest]);

      expect(
        await existing(tx, "chokepoint_transits", [stale, open, oldTransit, keptTransit]),
      ).toEqual([stale, open, keptTransit]);
      const closed = await tx.execute<{ id: number; ended_by: string | null; open: boolean }>(sql`
        select id, ended_by, left_at is null as open from chokepoint_transits
        where id in (${stale}, ${open}) order by id`);
      expect(closed.map((r) => [r.ended_by, r.open])).toEqual([
        [ABANDONED_TRANSIT, false],
        [null, true],
      ]);

      expect(await existing(tx, "altdata_events", [oldEvent, keptEvent])).toEqual([keptEvent]);
      expect(await existing(tx, "insights", [oldInsight, keptInsight, current])).toEqual([
        keptInsight,
        current,
      ]);

      expect(await existing(tx, "llm_usage", [...usageOld, usageNew])).toEqual([usageNew]);
      const daily = await tx.execute<{ calls: number; failures: number; prompt_tokens: string }>(
        sql`select calls, failures, prompt_tokens::text from llm_usage_daily
          where model = ${tag} and kind = ${tag}`,
      );
      expect(daily).toHaveLength(1);
      expect(daily[0]).toMatchObject({ calls: 3, failures: 1, prompt_tokens: "300" });

      const coverage = await tx.execute<{ zone: string }>(sql`
        select zone from altdata_coverage where layer = ${tag} order by zone`);
      expect(coverage.map((r) => r.zone)).toEqual(["new"]);
    });
  });

  it("stops before work when the deadline has passed", async () => {
    await rolledBack(db, async (tx) => {
      const result = await pruneRetention(tx, { expired: () => true });
      expect(result.complete).toBe(0);
      expect(result.campaigns).toBe(0);
    });
  });
});
