import { randomUUID } from "node:crypto";
import { closeDb, createDb, type Db, sql } from "@ma/db";
import { ORDER_RELATIONSHIP_EXTRACTOR_VERSION, RELATIONSHIP_EXTRACTOR_VERSION } from "@ma/ingest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ORDERS_PENDING, SOURCES_PENDING } from "./relationships.js";

const url = process.env.DATABASE_URL_TEST;

describe.skipIf(!url)("relationships due predicates (DATABASE_URL_TEST)", () => {
  let db: Db;
  let companyId: number;
  const tag = `test-${randomUUID().slice(0, 8)}`;

  async function due(predicate: typeof SOURCES_PENDING): Promise<boolean> {
    const rows = await db.execute(sql`
      select c.id from companies c
      left join company_sync s on s.company_id = c.id and s.job = 'relationships'
      where c.id = ${companyId} and ${predicate}`);
    return rows.length > 0;
  }

  async function source(
    family: string,
    opts: { read: "current" | "stale" | "never"; version?: number; readDaysAgo?: number },
  ): Promise<void> {
    const [doc] = await db.execute<{ id: number }>(sql`
      insert into documents (url, source, company_id, sha256, byte_size)
      values (${`https://${tag}/${randomUUID()}`}, ${family}, ${companyId}, 'x', 1)
      returning id`);
    const documentId = Number(doc?.id);
    const [rev] = await db.execute<{ id: number }>(sql`
      insert into document_revisions (document_id, content_sha256, text_bytes)
      values (${documentId}, ${randomUUID()}, 1) returning id`);
    const revisionId = Number(rev?.id);
    await db.execute(
      sql`update documents set current_revision_id = ${revisionId} where id = ${documentId}`,
    );
    const never = opts.read === "never";
    await db.execute(sql`
      insert into relationship_sources (company_id, family, document_id, read_revision_id,
        read_extractor_version, last_read_at)
      values (${companyId}, ${family}, ${documentId}, ${never ? null : revisionId},
        ${never ? null : (opts.version ?? RELATIONSHIP_EXTRACTOR_VERSION)},
        ${never ? null : sql`now() - make_interval(days => ${opts.readDaysAgo ?? 1})`})`);
    if (opts.read === "stale") {
      const [next] = await db.execute<{ id: number }>(sql`
        insert into document_revisions (document_id, content_sha256, text_bytes)
        values (${documentId}, ${randomUUID()}, 1) returning id`);
      await db.execute(
        sql`update documents set current_revision_id = ${Number(next?.id)} where id = ${documentId}`,
      );
    }
  }

  async function graphState(version: number): Promise<void> {
    await db.execute(sql`
      insert into company_graph_state (company_id, extractor_version) values (${companyId}, ${version})
      on conflict (company_id) do update set extractor_version = excluded.extractor_version`);
  }

  async function announcement(subject: string, categoryKey: string | null): Promise<number> {
    const [row] = await db.execute<{ id: number }>(sql`
      insert into announcements (company_id, published_at, subject, dedupe_key, category_key)
      values (${companyId}, now(), ${subject}, ${`${tag}-${randomUUID()}`}, ${categoryKey})
      returning id`);
    return Number(row?.id);
  }

  async function cleanup(): Promise<void> {
    await db.execute(sql`delete from relationship_sources where company_id = ${companyId}`);
    await db.execute(sql`delete from documents where company_id = ${companyId}`);
    await db.execute(sql`delete from announcements where company_id = ${companyId}`);
    await db.execute(sql`delete from company_graph_state where company_id = ${companyId}`);
    await db.execute(sql`delete from company_sync where company_id = ${companyId}`);
  }

  beforeAll(async () => {
    db = createDb(url ?? "", 1);
    const [row] = await db.execute<{ id: number }>(sql`
      insert into companies (name, normalized_name) values (${tag}, ${tag}) returning id`);
    companyId = Number(row?.id);
  });

  beforeEach(async () => {
    await cleanup();
    await db.execute(sql`
      insert into company_sync (company_id, job, synced_at, attempted_at)
      values (${companyId}, 'relationships', now() - interval '2 days', now() - interval '2 days')`);
  });

  afterAll(async () => {
    await cleanup();
    await db.execute(sql`delete from companies where id = ${companyId}`);
    await closeDb(db);
  });

  it("is due until the company graph is built at the current extractor version", async () => {
    expect(await due(SOURCES_PENDING)).toBe(true);
    await graphState(RELATIONSHIP_EXTRACTOR_VERSION - 1);
    expect(await due(SOURCES_PENDING)).toBe(true);
    await graphState(RELATIONSHIP_EXTRACTOR_VERSION);
    expect(await due(SOURCES_PENDING)).toBe(false);
  });

  it("is due when a source is unread, has a new revision or an old read version", async () => {
    await graphState(RELATIONSHIP_EXTRACTOR_VERSION);
    await source("annual_report", { read: "current" });
    expect(await due(SOURCES_PENDING)).toBe(false);
    await source("concall", { read: "never" });
    expect(await due(SOURCES_PENDING)).toBe(true);
    await cleanup();
    await graphState(RELATIONSHIP_EXTRACTOR_VERSION);
    await source("annual_report", { read: "stale" });
    expect(await due(SOURCES_PENDING)).toBe(true);
    await cleanup();
    await graphState(RELATIONSHIP_EXTRACTOR_VERSION);
    await source("concall", { read: "current", version: RELATIONSHIP_EXTRACTOR_VERSION - 1 });
    expect(await due(SOURCES_PENDING)).toBe(true);
  });

  it("re-reads a changed screener page at most monthly", async () => {
    await graphState(RELATIONSHIP_EXTRACTOR_VERSION);
    await source("screener", { read: "stale", readDaysAgo: 5 });
    expect(await due(SOURCES_PENDING)).toBe(false);
    await source("screener", { read: "stale", readDaysAgo: 40 });
    expect(await due(SOURCES_PENDING)).toBe(true);
  });

  it("is not due again within a day of the last sync", async () => {
    await db.execute(sql`
      update company_sync set synced_at = now() - interval '1 hour'
      where company_id = ${companyId} and job = 'relationships'`);
    expect(await due(SOURCES_PENDING)).toBe(false);
  });

  it("picks companies with unread order-win announcements", async () => {
    await announcement("Intimation of trading window closure", "trading_window");
    expect(await due(ORDERS_PENDING)).toBe(false);
    const id = await announcement("Receipt of order from NHAI worth Rs 1,250 crore", null);
    expect(await due(ORDERS_PENDING)).toBe(true);
    const [doc] = await db.execute<{ id: number }>(sql`
      insert into documents (url, source, company_id, sha256, byte_size)
      values (${`nse://announcement/${id}`}, 'announcement_metadata', ${companyId}, 'x', 1)
      returning id`);
    await db.execute(sql`
      insert into relationship_sources (company_id, family, document_id, read_extractor_version)
      values (${companyId}, 'announcement_metadata', ${Number(doc?.id)},
        ${ORDER_RELATIONSHIP_EXTRACTOR_VERSION})`);
    expect(await due(ORDERS_PENDING)).toBe(false);
    await announcement("Press Release", "order_win");
    expect(await due(ORDERS_PENDING)).toBe(true);
  });
});
