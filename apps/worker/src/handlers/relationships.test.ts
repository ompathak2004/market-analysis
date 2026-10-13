import { randomUUID } from "node:crypto";
import { closeDb, createDb, type Db, sql } from "@ma/db";
import { RELATIONSHIP_EXTRACTOR_VERSION } from "@ma/ingest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DOCUMENTS_PENDING } from "./relationships.js";

const url = process.env.DATABASE_URL_TEST;

describe.skipIf(!url)("relationships due predicate (DATABASE_URL_TEST)", () => {
  let db: Db;
  let companyId: number;
  const tag = `test-${randomUUID().slice(0, 8)}`;

  async function due(): Promise<boolean> {
    const rows = await db.execute(sql`
      select c.id from companies c
      left join company_sync s on s.company_id = c.id and s.job = 'relationships'
      where c.id = ${companyId} and ${DOCUMENTS_PENDING}`);
    return rows.length > 0;
  }

  async function doc(source: string, ageDays: number, parserVersion: number | null) {
    await db.execute(sql`
      insert into documents (url, source, company_id, sha256, byte_size, content, parser_version,
        fetched_at)
      values (${`https://${tag}/${randomUUID()}`}, ${source}, ${companyId}, 'x', 1, 'x',
        ${parserVersion}, now() - make_interval(days => ${ageDays}))`);
  }

  beforeAll(async () => {
    db = createDb(url ?? "", 1);
    const [row] = await db.execute<{ id: number }>(sql`
      insert into companies (name, normalized_name) values (${tag}, ${tag}) returning id`);
    companyId = Number(row?.id);
  });

  beforeEach(async () => {
    await db.execute(sql`delete from documents where company_id = ${companyId}`);
    await db.execute(sql`delete from company_sync where company_id = ${companyId}`);
    await db.execute(sql`
      insert into company_sync (company_id, job, synced_at, attempted_at)
      values (${companyId}, 'relationships', now() - interval '2 days', now() - interval '2 days')`);
  });

  afterAll(async () => {
    await db.execute(sql`delete from documents where company_id = ${companyId}`);
    await db.execute(sql`delete from company_sync where company_id = ${companyId}`);
    await db.execute(sql`delete from companies where id = ${companyId}`);
    await closeDb(db);
  });

  it("ignores stale-version documents older than the ones extract reads", async () => {
    const current = RELATIONSHIP_EXTRACTOR_VERSION;
    for (const age of [3, 4]) await doc("annual_report", age, current);
    for (const age of [3, 4, 5, 6]) await doc("concall", age, current);
    // Older than the newest 2 annual reports and 4 concalls, never re-parsed by extract.
    await doc("annual_report", 400, null);
    await doc("concall", 400, current - 1);
    expect(await due()).toBe(false);
  });

  it("is due when one of the documents extract reads is below the extractor version", async () => {
    await doc("annual_report", 3, RELATIONSHIP_EXTRACTOR_VERSION);
    await doc("annual_report", 4, null);
    expect(await due()).toBe(true);
  });

  it("is due when a read document was fetched after the last sync", async () => {
    await doc("concall", 1, RELATIONSHIP_EXTRACTOR_VERSION);
    expect(await due()).toBe(true);
  });
});
