import { randomUUID } from "node:crypto";
import { createLogger, MemoryObjectStore } from "@ma/core";
import { closeDb, companies, createDb, type Db, inArray, sql } from "@ma/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IngestContext } from "../context.js";
import { DocumentStore } from "../documents.js";
import type { Firecrawl } from "../firecrawl.js";
import type { HttpClient } from "../http.js";
import {
  extractOrdersForCompany,
  ORDER_RELATIONSHIP_EXTRACTOR_VERSION,
  orderAnnouncementUrl,
} from "../pipelines/orders.js";
import { loadCounterpartyMatcher, syncCounterparties } from "./counterparties.js";

const url = process.env.DATABASE_URL_TEST;

function letters(n: number): string {
  return Array.from({ length: n }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26)))
    .join("")
    .replace(/^./, (c) => c.toUpperCase());
}

describe.skipIf(!url)("order filings to graph edges (DATABASE_URL_TEST)", () => {
  let db: Db;
  let ctx: IngestContext;
  const tag = letters(7);
  const supplierName = `Voltrana ${tag} Infra Limited`;
  const customerName = `Gridmora ${tag} Power Limited`;
  const unlistedName = `Zorvex ${tag} Engineering`;
  let supplierId = 0;
  let customerId = 0;
  const announcementIds: number[] = [];

  async function announce(subject: string, details: string): Promise<number> {
    const [row] = await db.execute<{ id: number }>(sql`
      insert into announcements (company_id, published_at, subject, details, dedupe_key, category_key)
      values (${supplierId}, now() - interval '3 days', ${subject}, ${details},
        ${`${tag}-${randomUUID()}`}, 'order_win')
      returning id`);
    const id = Number(row?.id);
    announcementIds.push(id);
    return id;
  }

  beforeAll(async () => {
    db = createDb(url ?? "", 1);
    const logger = createLogger("test", "error");
    ctx = {
      db,
      docs: new DocumentStore(
        db,
        {} as HttpClient,
        {} as Firecrawl,
        logger,
        new MemoryObjectStore(),
      ),
      logger,
    } as unknown as IngestContext;
    const rows = await db
      .insert(companies)
      .values([
        { name: supplierName, normalizedName: supplierName.toLowerCase(), listed: true },
        { name: customerName, normalizedName: customerName.toLowerCase(), listed: true },
      ])
      .returning({ id: companies.id });
    supplierId = rows[0]?.id ?? 0;
    customerId = rows[1]?.id ?? 0;
  });

  afterAll(async () => {
    const ids = [supplierId, customerId];
    await db.execute(sql`
      delete from relationships
      where supplier_company_id in (${supplierId}, ${customerId})
        or customer_company_id in (${supplierId}, ${customerId})`);
    await db.execute(sql`
      delete from counterparties
      where company_id in (${supplierId}, ${customerId}) or normalized_name like ${`%${tag.toLowerCase()}%`}`);
    await db.execute(sql`delete from documents where company_id in (${supplierId}, ${customerId})`);
    await db.execute(sql`delete from announcements where company_id = ${supplierId}`);
    await db.delete(companies).where(inArray(companies.id, ids));
    await closeDb(db);
  });

  it("syncs a counterparty for every company", async () => {
    await syncCounterparties(db);
    const matcher = await loadCounterpartyMatcher(db);
    expect(matcher.byCompany.get(supplierId)?.kind).toBe("listed");
    expect(matcher.byCompany.get(customerId)?.kind).toBe("listed");
  });

  it("turns an order-win announcement into an observation, evidence and an active edge", async () => {
    const id = await announce(
      "Receipt of order",
      `${supplierName} has received an order worth Rs 450 crore from ${customerName} for supply of transformers. The order is to be executed within 18 months.`,
    );
    const matcher = await loadCounterpartyMatcher(db);
    const result = await extractOrdersForCompany(ctx, supplierId, matcher);
    expect(result).toMatchObject({ announcements: 1, documents: 1, failed: 0, remaining: 0 });
    expect(result.observations).toBe(1);
    expect(result.relationships).toBe(1);

    const [source] = await db.execute<{ family: string; read_extractor_version: number }>(sql`
      select rs.family, rs.read_extractor_version from relationship_sources rs
      join documents d on d.id = rs.document_id
      where d.url = ${orderAnnouncementUrl(id)} and rs.company_id = ${supplierId}`);
    expect(source).toEqual({
      family: "announcement_metadata",
      read_extractor_version: ORDER_RELATIONSHIP_EXTRACTOR_VERSION,
    });

    const observations = await db.execute<{
      cue_class: string;
      cost_bucket: string;
      value_cr: string;
      order_status: string;
      quote: string;
      customer_company_id: number;
    }>(sql`
      select o.cue_class, o.cost_bucket, o.value_cr, o.order_status, e.quote,
        cc.company_id as customer_company_id
      from relationship_observations o
      join relationship_observation_evidence oe on oe.observation_id = o.id
      join evidence_spans e on e.id = oe.evidence_span_id
      join counterparties cc on cc.id = o.customer_counterparty_id
      where o.focal_company_id = ${supplierId}`);
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      cue_class: "order",
      cost_bucket: "CAPEX",
      order_status: "awarded",
      customer_company_id: customerId,
    });
    expect(Number(observations[0]?.value_cr)).toBe(450);
    expect(observations[0]?.quote).toContain(customerName);

    const edges = await db.execute<{ edge_key: string | null; status: string }>(sql`
      select edge_key, status from relationships
      where supplier_company_id = ${supplierId} and customer_company_id = ${customerId}`);
    expect(edges).toHaveLength(1);
    expect(edges[0]?.status).toBe("active");
    expect(edges[0]?.edge_key).toBeTruthy();

    const [state] = await db.execute<{ edges: number; extractor_version: number }>(sql`
      select edges, extractor_version from company_graph_state where company_id = ${supplierId}`);
    expect(state?.edges).toBeGreaterThanOrEqual(1);
    expect(state?.extractor_version).toBe(0);
  });

  it("does not re-read a filing it has already read", async () => {
    const matcher = await loadCounterpartyMatcher(db);
    const again = await extractOrdersForCompany(ctx, supplierId, matcher);
    expect(again.announcements).toBe(0);
    const forced = await extractOrdersForCompany(
      ctx,
      supplierId,
      matcher,
      new AbortController().signal,
      {
        force: true,
      },
    );
    expect(forced.observations).toBe(0);
    const [count] = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from relationship_observations where focal_company_id = ${supplierId}`);
    expect(count?.n).toBe(1);
  });

  it("creates an unlisted counterparty for an unknown awarder", async () => {
    await announce(
      "Letter of Award",
      `The Company has received a Letter of Award from ${unlistedName} Private Limited for EPC works valued at Rs 120 crore.`,
    );
    const matcher = await loadCounterpartyMatcher(db);
    const result = await extractOrdersForCompany(ctx, supplierId, matcher);
    expect(result.observations).toBe(1);
    const rows = await db.execute<{ kind: string; new_counterparty: boolean; status: string }>(sql`
      select cp.kind, o.new_counterparty, r.status
      from relationship_observations o
      join counterparties cp on cp.id = o.customer_counterparty_id
      join relationships r on r.customer_counterparty_id = cp.id and r.supplier_company_id = ${supplierId}
      where o.focal_company_id = ${supplierId} and cp.company_id is null`);
    expect(rows).toEqual([{ kind: "private", new_counterparty: true, status: "active" }]);
  });
});
