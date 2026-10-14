import { randomUUID } from "node:crypto";
import { createLogger, MemoryObjectStore } from "@ma/core";
import { closeDb, createDb, type Db, fencedTransaction, sql } from "@ma/db";
import {
  DocumentStore,
  FINANCIAL_FACTS_PARSER_VERSION,
  type Firecrawl,
  type HttpClient,
  registerSource,
} from "@ma/ingest";
import { annualFinancials } from "@ma/intel";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WorkerContext } from "../context.js";
import type { UnitRun } from "../registry.js";
import { relationshipFactHandlers } from "./relationships-facts.js";

const url = process.env.DATABASE_URL_TEST;

function report(materials: string): string {
  return `Independent Auditor's Report on the Consolidated Financial Statements.

Consolidated Statement of Profit and Loss for the year ended 31st March, 2025
(₹ in crore)
Particulars Note Year ended 31st March, 2025 Year ended 31st March, 2024
Revenue from operations 24 4,321.00 4,000.00
Other income 25 21.00 18.00
Cost of materials consumed 26 ${materials} 2,300.00
Purchases of stock-in-trade 27 100.00 90.00
Changes in inventories of finished goods and work-in-progress 28 (50.00) 25.00
Employee benefits expense 29 400.00 380.00
Profit attributable to non-controlling interests 2.00 1.00

Consolidated Statement of Cash Flows for the year ended 31st March, 2025
(₹ in crore)
B. Cash flow from investing activities
Purchase of property, plant and equipment (210.50) (180.00)
`;
}

describe.skipIf(!url)("relationships.facts handlers (DATABASE_URL_TEST)", () => {
  let db: Db;
  let docs: DocumentStore;
  const logger = createLogger("test", "silent");
  const tag = `F${randomUUID().slice(0, 8).toUpperCase()}`;
  const docUrl = `https://example.com/${tag}/annual-report-2024-25.pdf`;
  const ids = { company: 0, index: 0, document: 0 };

  const ctx = () =>
    ({ db, docs, logger, config: { INTEL_UNIVERSE: tag } }) as unknown as WorkerContext;

  function run<T extends "relationships.facts.fanout" | "relationships.facts">(
    type: T,
    payload: object,
  ): UnitRun<T> {
    return {
      ctx: ctx(),
      type,
      payload: payload as UnitRun<T>["payload"],
      attempt: 1,
      campaignId: null,
      deadline: Date.now() + 60_000,
      signal: new AbortController().signal,
      fence: undefined as unknown as UnitRun["fence"],
      expired: () => false,
    };
  }

  const fanout = async () => {
    const r = await relationshipFactHandlers["relationships.facts.fanout"](
      run("relationships.facts.fanout", {}),
    );
    return (r.children ?? []).map((c) => c.payload.companyId);
  };
  const sync = async () =>
    (
      await relationshipFactHandlers["relationships.facts"](
        run("relationships.facts", { companyId: ids.company }),
      )
    ).metrics;

  async function facts() {
    return db.execute<{ metric: string; value: string; revision: number; version: number }>(sql`
      select metric::text, value_cr::text as value, source_revision_id::int as revision,
        parser_version as version
      from relationship_financial_facts
      where company_id = ${ids.company} and period_end = '2025-03-31' and period_type = 'annual'
      order by metric`);
  }

  beforeAll(async () => {
    db = createDb(url ?? "", 1);
    docs = new DocumentStore(
      db,
      {} as HttpClient,
      {} as Firecrawl,
      logger,
      new MemoryObjectStore(),
    );
    const [c] = await db.execute<{ id: number }>(sql`
      insert into companies (name, normalized_name, listed, market_cap_cr)
      values (${tag}, ${tag.toLowerCase()}, true, 1) returning id`);
    ids.company = Number(c?.id);
    const [i] = await db.execute<{ id: number }>(
      sql`insert into indices (code, name) values (${tag}, ${tag}) returning id`,
    );
    ids.index = Number(i?.id);
    await db.execute(sql`
      insert into index_constituents (index_id, company_id) values (${ids.index}, ${ids.company})`);
    const stored = await docs.putInline(docUrl, report("2,500.00"), {
      source: "annual_report",
      companyId: ids.company,
    });
    ids.document = stored.doc.id;
    await fencedTransaction(db, (tx) =>
      registerSource(tx, {
        companyId: ids.company,
        family: "annual_report",
        documentId: ids.document,
        label: "Annual Report 2024-25",
        publishedAt: "2025-07-15",
      }),
    );
  });

  afterAll(async () => {
    await db.execute(sql`delete from documents where company_id = ${ids.company}`);
    await db.execute(sql`delete from companies where id = ${ids.company}`);
    await db.execute(sql`delete from indices where id = ${ids.index}`);
    await closeDb(db);
  });

  it("fans out companies with an unread annual report and writes their facts", async () => {
    expect(await fanout()).toContain(ids.company);
    expect(await sync()).toEqual({ documents: 1, parsed: 1, unparsed: 0, failed: 0, facts: 4 });
    const rows = await facts();
    expect(Object.fromEntries(rows.map((r) => [r.metric, Number(r.value)]))).toEqual({
      revenue: 4321,
      purchases: 2600,
      cogs: 2550,
      capex: 210.5,
    });
    expect(rows.every((r) => r.version === FINANCIAL_FACTS_PARSER_VERSION)).toBe(true);
    const [synced] = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from company_sync
      where company_id = ${ids.company} and job = 'financial_facts' and synced_at is not null`);
    expect(Number(synced?.n)).toBe(1);
  });

  it("does not reread a parsed revision", async () => {
    expect(await fanout()).not.toContain(ids.company);
    expect(await sync()).toEqual({ documents: 0, parsed: 0, unparsed: 0, failed: 0, facts: 0 });
    expect(await facts()).toHaveLength(4);
  });

  it("replaces facts from a newer revision of the report", async () => {
    const before = (await facts())[0]?.revision;
    await docs.putInline(docUrl, report("2,700.00"), {
      source: "annual_report",
      companyId: ids.company,
    });
    expect(await fanout()).toContain(ids.company);
    expect(await sync()).toMatchObject({ documents: 1, parsed: 1, facts: 4 });
    const rows = await facts();
    expect(rows).toHaveLength(4);
    expect(Object.fromEntries(rows.map((r) => [r.metric, Number(r.value)]))).toMatchObject({
      purchases: 2800,
      cogs: 2750,
    });
    expect(new Set(rows.map((r) => r.revision)).size).toBe(1);
    expect(rows[0]?.revision).toBeGreaterThan(before ?? 0);
  });

  it("feeds purchases to the estimator inputs", async () => {
    const fins = await annualFinancials(db, [ids.company], "2025-12-31");
    expect(fins.get(ids.company)).toEqual([
      {
        periodEnd: "2025-03-31",
        revenue: 4321,
        cogs: 2750,
        purchases: 2800,
        capex: 210.5,
        sga: null,
        rnd: null,
      },
    ]);
  });
});
