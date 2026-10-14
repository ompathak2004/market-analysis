import { randomUUID } from "node:crypto";
import { MemoryObjectStore } from "@ma/core";
import { closeDb, createDb, type Db, sql, type Tx } from "@ma/db";
import { NonRetryableError } from "@ma/jobs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WorkerContext } from "../context.js";
import type { ChildJob } from "../registry.js";
import { BACKUP_UNENCRYPTED_METRIC, maintenanceHandlers } from "./maintenance.js";

const url = process.env.DATABASE_URL_TEST;

class Rollback extends Error {}

type Step = Exclude<keyof typeof maintenanceHandlers, "maintenance.announcements.reindex">;

describe.skipIf(!url)("maintenance.announcements chain (DATABASE_URL_TEST)", () => {
  let db: Db;
  const tag = `chain-${randomUUID().slice(0, 8)}`;

  beforeAll(() => {
    db = createDb(url ?? "", 2);
  });

  afterAll(async () => {
    await closeDb(db);
  });

  function harness(tx: Tx) {
    const counts: Record<string, number> = {};
    const objects = new MemoryObjectStore();
    const ctx = {
      db: tx,
      objects,
      env: {},
      api: { invalidatePrefix: async () => undefined },
      metrics: {
        count: (name: string, value = 1) => {
          counts[name] = (counts[name] ?? 0) + value;
        },
      },
      logger: { warn: () => undefined, info: () => undefined, error: () => undefined },
    } as unknown as WorkerContext;
    const run = <T extends Step>(type: T, payload: object): Promise<{ children?: ChildJob[] }> =>
      maintenanceHandlers[type]({
        ctx,
        type,
        payload,
        attempt: 1,
        campaignId: null,
        deadline: Date.now() + 60_000,
        signal: new AbortController().signal,
        fence: undefined,
        expired: () => false,
      } as never);
    return { counts, objects, run };
  }

  async function rolledBack(fn: (tx: Tx) => Promise<void>): Promise<void> {
    await db
      .transaction(async (tx) => {
        await fn(tx);
        throw new Rollback();
      })
      .catch((err: unknown) => {
        if (!(err instanceof Rollback)) throw err;
      });
  }

  async function seed(tx: Tx): Promise<{ noise: number; kept: number }> {
    const company = await tx.execute<{ id: number }>(sql`
      insert into companies (name, normalized_name) values (${tag}, ${tag}) returning id`);
    const insert = async (subject: string) => {
      const rows = await tx.execute<{ id: number }>(sql`
        insert into announcements (company_id, published_at, subject, dedupe_key, policy_version)
        values (${company[0]?.id}, '2015-01-05T00:00:00Z', ${subject}, ${randomUUID()}, 0)
        returning id`);
      return Number(rows[0]?.id);
    };
    return {
      noise: await insert("Closure of Trading Window"),
      kept: await insert("Financial Results for the quarter ended June 30, 2015"),
    };
  }

  it("refuses to delete without a verified backup", async () => {
    await rolledBack(async (tx) => {
      const { noise } = await seed(tx);
      const { run } = harness(tx);
      await expect(
        run("maintenance.announcements.delete", {
          day: "2026-10-14",
          maxId: noise,
          backupKey: "backups/announcements-2026-10-14.ndjson.gz",
        }),
      ).rejects.toBeInstanceOf(NonRetryableError);
      const left = await tx.execute(sql`select 1 from announcements where id = ${noise}`);
      expect(left).toHaveLength(1);
    });
  });

  it("backs up, classifies and deletes in order", async () => {
    await rolledBack(async (tx) => {
      const { noise, kept } = await seed(tx);
      const { counts, objects, run } = harness(tx);
      const root = await run("maintenance.announcements", {});
      const steps: string[] = [];
      let next = root.children?.[0];
      while (next && next.type !== "maintenance.announcements.reindex") {
        steps.push(next.type);
        next = (await run(next.type as Step, next.payload)).children?.[0];
      }
      expect(steps).toEqual([
        "maintenance.announcements.backup",
        "maintenance.announcements.classify",
        "maintenance.announcements.delete",
      ]);
      expect(next?.type).toBe("maintenance.announcements.reindex");
      expect(counts[BACKUP_UNENCRYPTED_METRIC]).toBe(1);
      expect([...objects.objects.keys()]).toEqual([
        expect.stringMatching(/^backups\/announcements-\d{4}-\d{2}-\d{2}\.ndjson\.gz$/),
      ]);
      const left = await tx.execute<{ id: number }>(sql`
        select id from announcements where id in (${noise}, ${kept}) order by id`);
      expect(left.map((r) => Number(r.id))).toEqual([kept]);
    });
  });
});
