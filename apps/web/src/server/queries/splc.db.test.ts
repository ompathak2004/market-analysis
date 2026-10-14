import { randomUUID } from "node:crypto";
import { closeDb, createDb, type Db, sql } from "@ma/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "../context";
import { supplyChain, supplyChainKey } from "./core";
import { reviewQueue, reviewRelationship } from "./reviews";

const url = process.env.DATABASE_URL_TEST;

function day(offset: number): string {
  return new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
}

type Id = { id: number };

describe.skipIf(!url)("SPLC v2 read model and review queue (DATABASE_URL_TEST)", () => {
  let db: Db;
  let readOnly: Db;
  const tag = `W${randomUUID().slice(0, 8).toUpperCase()}`;
  const invalidated: string[] = [];
  const seed = {
    supplier: 0,
    customer: 0,
    cSupplier: 0,
    cCustomer: 0,
    cPrivate: 0,
    docs: [] as number[],
    revision: 0,
    spans: [] as number[],
    extraction: 0,
    obs: { listed: 0, contract: 0, older: 0, confident: 0 },
    rels: { listed: 0, contract: 0, expired: 0, legacy: 0 },
  };

  const ctxOf = (d: Db) =>
    ({
      db: d,
      api: {
        getOrLoad: <T>(_k: string, load: () => Promise<T>) => load(),
        invalidatePrefix: async (p: string) => {
          invalidated.push(p);
          return 0;
        },
      },
      logger: { warn: () => undefined },
    }) as unknown as AppContext;

  async function one(q: ReturnType<typeof sql>): Promise<Id> {
    const [row] = await db.execute<Id>(q);
    if (!row) throw new Error("insert returned no row");
    return row;
  }

  async function company(sym: string): Promise<number> {
    const c = await one(sql`
      insert into companies (name, normalized_name, nse_symbol, listing_status)
      values (${`${sym} Ltd`}, ${sym.toLowerCase()}, ${sym}, 'active') returning id`);
    return Number(c.id);
  }

  async function counterparty(name: string, kind: string, companyId: number | null) {
    const c = await one(sql`
      insert into counterparties (kind, canonical_name, normalized_name, company_id)
      values (${kind}::counterparty_kind, ${name}, ${name.toLowerCase()}, ${companyId})
      returning id`);
    return Number(c.id);
  }

  async function document(n: number, source: string) {
    const d = await one(sql`
      insert into documents (url, source, sha256, byte_size, company_id, published_at)
      values (${`https://example.test/${tag}/${n}.pdf`}, ${source}, ${`${tag}${n}`}, 10,
              ${seed.supplier}, now() - interval '30 days')
      returning id`);
    return Number(d.id);
  }

  async function span(start: number, quote: string, page: number) {
    const s = await one(sql`
      insert into evidence_spans (document_revision_id, start_offset, end_offset, quote, page)
      values (${seed.revision}, ${start}, ${start + quote.length}, ${quote}, ${page})
      returning id`);
    return Number(s.id);
  }

  async function observation(o: {
    supplier: number;
    customer: number;
    basis: string;
    confidence: number;
    status: string;
    isNew: boolean;
    span: number | null;
    createdAt: string;
    pct?: number;
    valueCr?: number;
  }) {
    const row = await one(sql`
      insert into relationship_observations (
        extraction_id, focal_company_id, supplier_counterparty_id, customer_counterparty_id,
        disclosed_by, disclosure_kind, cost_bucket, value_basis, cue_class, pct, value_cr,
        currency, period_start, period_end, fiscal_year, claim, confidence, status,
        new_counterparty, created_at)
      values (${seed.extraction}, ${seed.supplier}, ${o.supplier}, ${o.customer}, 'supplier',
              'major_customer', 'COGS', ${o.basis}::value_basis, ${o.basis}, ${o.pct ?? null},
              ${o.valueCr ?? null}, 'INR', '2024-04-01', '2025-03-31', 2025,
              ${`${tag} claim ${o.basis}`}, ${o.confidence}, ${o.status}::observation_status,
              ${o.isNew}, ${o.createdAt}::timestamptz)
      returning id`);
    if (o.span)
      await db.execute(sql`
        insert into relationship_observation_evidence (observation_id, evidence_span_id)
        values (${row.id}, ${o.span})`);
    return Number(row.id);
  }

  async function relationship(r: {
    supplier: number;
    customer: number;
    supplierCompany: number | null;
    customerCompany: number | null;
    basis: string;
    status: string;
    validTo: string;
    disclosedValue?: number;
  }) {
    const row = await one(sql`
      insert into relationships (
        supplier_company_id, supplier_name, customer_company_id, customer_name, cost_bucket,
        disclosed_by, disclosure_kind, disclosed_pct, disclosed_value, fiscal_year, valid_from,
        valid_to, confidence, supplier_counterparty_id, customer_counterparty_id, edge_key,
        value_basis, extractor_family, extractor_version, graph_revision, status,
        last_disclosed_at, observation_count)
      values (${r.supplierCompany}, ${`${tag}-S-${r.supplier}`}, ${r.customerCompany},
              ${`${tag}-C-${r.customer}-${r.basis}-${r.status}`}, 'COGS', 'supplier',
              'major_customer', ${r.basis === "revenue_share" ? 12.5 : null},
              ${r.disclosedValue ?? null}, 2025, '2024-04-01', ${r.validTo}, 0.9, ${r.supplier},
              ${r.customer}, ${`${tag}:${r.supplier}:${r.customer}:${r.basis}:${r.status}`},
              ${r.basis}::value_basis, 'annual_report', 3, 1, ${r.status}::relationship_status,
              '2025-05-01', 1)
      returning id`);
    return Number(row.id);
  }

  beforeAll(async () => {
    db = createDb(url as string, 2);
    readOnly = createDb(
      `${url}${(url as string).includes("?") ? "&" : "?"}default_transaction_read_only=on`,
      1,
    );
    seed.supplier = await company(`${tag}S`);
    seed.customer = await company(`${tag}C`);
    seed.cSupplier = await counterparty(`${tag} Supplier`, "listed", seed.supplier);
    seed.cCustomer = await counterparty(`${tag} Customer`, "listed", seed.customer);
    seed.cPrivate = await counterparty(`${tag} Private Works`, "private", null);
    seed.docs = [await document(1, "annual_report"), await document(2, "order_filing")];
    const rev = await one(sql`
      insert into document_revisions (document_id, content_sha256, text_bytes, published_at)
      values (${seed.docs[0]}, ${`${tag}rev`}, 100, now() - interval '20 days') returning id`);
    seed.revision = Number(rev.id);
    seed.spans = [
      await span(0, `${tag} customer accounts for 12.5% of revenue`, 41),
      await span(60, `${tag} order worth Rs 500 crore from Private Works`, 3),
      await span(120, `${tag} older low-confidence mention`, 7),
    ];
    const ex = await one(sql`
      insert into relationship_extractions (document_revision_id, company_id, extractor_family,
                                            extractor_version, inputs_hash, status)
      values (${seed.revision}, ${seed.supplier}, 'annual_report', 3, ${tag}, 'succeeded')
      returning id`);
    seed.extraction = Number(ex.id);
    seed.obs.older = await observation({
      supplier: seed.cSupplier,
      customer: seed.cPrivate,
      basis: "annual_flow",
      confidence: 0.4,
      status: "pending",
      isNew: false,
      span: seed.spans[2] ?? null,
      createdAt: "2020-01-01T00:00:00.000001Z",
    });
    seed.obs.listed = await observation({
      supplier: seed.cSupplier,
      customer: seed.cCustomer,
      basis: "revenue_share",
      confidence: 0.92,
      status: "auto",
      isNew: false,
      span: seed.spans[0] ?? null,
      createdAt: "2020-01-02T00:00:00Z",
      pct: 12.5,
    });
    seed.obs.contract = await observation({
      supplier: seed.cSupplier,
      customer: seed.cPrivate,
      basis: "contract_total",
      confidence: 0.95,
      status: "pending",
      isNew: true,
      span: seed.spans[1] ?? null,
      createdAt: "2020-01-02T00:00:00Z",
      valueCr: 500,
    });
    seed.obs.confident = await observation({
      supplier: seed.cSupplier,
      customer: seed.cCustomer,
      basis: "revenue_share",
      confidence: 0.85,
      status: "pending",
      isNew: false,
      span: null,
      createdAt: "2020-01-01T00:00:00Z",
    });
    seed.rels.listed = await relationship({
      supplier: seed.cSupplier,
      customer: seed.cCustomer,
      supplierCompany: seed.supplier,
      customerCompany: seed.customer,
      basis: "revenue_share",
      status: "active",
      validTo: day(365),
    });
    seed.rels.contract = await relationship({
      supplier: seed.cSupplier,
      customer: seed.cPrivate,
      supplierCompany: seed.supplier,
      customerCompany: null,
      basis: "contract_total",
      status: "active",
      validTo: day(365),
      disclosedValue: 500,
    });
    seed.rels.expired = await relationship({
      supplier: seed.cPrivate,
      customer: seed.cSupplier,
      supplierCompany: null,
      customerCompany: seed.supplier,
      basis: "annual_flow",
      status: "expired",
      validTo: day(-1),
    });
    seed.rels.legacy = await relationship({
      supplier: seed.cCustomer,
      customer: seed.cSupplier,
      supplierCompany: seed.customer,
      customerCompany: seed.supplier,
      basis: "unknown",
      status: "legacy",
      validTo: day(365),
    });
    await db.execute(sql`
      insert into relationship_estimates (relationship_id, as_of, method, value_cr, value_low_cr,
                                          value_high_cr, supplier_revenue_pct, inputs,
                                          model_version, value_basis)
      values (${seed.rels.listed}, '2025-01-01', 'disclosed', 100, 90, 110, 12.5, '{}'::jsonb, 1,
              'revenue_share'),
             (${seed.rels.listed}, '2025-06-01', 'disclosed', 120, 110, 130, 12.5, '{}'::jsonb, 1,
              'revenue_share'),
             (${seed.rels.listed}, '2025-07-01', 'estimated', 999, 900, 1100, 50, '{}'::jsonb, 0,
              'revenue_share'),
             (${seed.rels.contract}, '2025-06-01', 'disclosed', 500, 500, 500, null, '{}'::jsonb,
              1, 'contract_total')`);
    await db.execute(sql`
      insert into relationship_sources (company_id, family, document_id, read_revision_id,
                                        last_read_at)
      values (${seed.supplier}, 'annual_report', ${seed.docs[0]}, ${seed.revision},
              '2025-06-02T10:00:00Z'),
             (${seed.supplier}, 'order_filing', ${seed.docs[1]}, null, null),
             (${seed.supplier}, 'legacy', ${seed.docs[1]}, null, null)`);
  });

  afterAll(async () => {
    if (!db) return;
    const companyIds = [seed.supplier, seed.customer].filter(Boolean);
    const cps = [seed.cSupplier, seed.cCustomer, seed.cPrivate].filter(Boolean);
    const rels = Object.values(seed.rels).filter(Boolean);
    const obs = Object.values(seed.obs).filter(Boolean);
    const list = (xs: number[]) =>
      sql.join(
        xs.map((x) => sql`${x}`),
        sql`, `,
      );
    if (obs.length) {
      await db.execute(
        sql`delete from relationship_reviews where observation_id in (${list(obs)})`,
      );
      await db.execute(
        sql`delete from relationship_observation_evidence where observation_id in (${list(obs)})`,
      );
    }
    if (cps.length)
      await db.execute(sql`delete from relationship_blocks
        where supplier_counterparty_id in (${list(cps)}) or customer_counterparty_id in (${list(cps)})`);
    if (rels.length) {
      await db.execute(
        sql`delete from relationship_estimates where relationship_id in (${list(rels)})`,
      );
      await db.execute(sql`delete from relationships where id in (${list(rels)})`);
    }
    if (obs.length)
      await db.execute(sql`delete from relationship_observations where id in (${list(obs)})`);
    if (seed.extraction)
      await db.execute(sql`delete from relationship_extractions where id = ${seed.extraction}`);
    if (seed.spans.length)
      await db.execute(sql`delete from evidence_spans where id in (${list(seed.spans)})`);
    if (companyIds.length)
      await db.execute(
        sql`delete from relationship_sources where company_id in (${list(companyIds)})`,
      );
    if (seed.revision)
      await db.execute(sql`delete from document_revisions where id = ${seed.revision}`);
    if (seed.docs.length)
      await db.execute(sql`delete from documents where id in (${list(seed.docs)})`);
    if (cps.length) await db.execute(sql`delete from counterparties where id in (${list(cps)})`);
    if (companyIds.length)
      await db.execute(sql`delete from companies where id in (${list(companyIds)})`);
    await closeDb(db);
    await closeDb(readOnly);
  });

  it("returns schemaVersion 2 edges with evidence, estimates and coverage", async () => {
    const chain = await supplyChain(ctxOf(db), `${tag}S`);
    expect(chain.schemaVersion).toBe(2);
    expect(chain.company).toEqual({ id: seed.supplier, symbol: `${tag}S` });
    expect(chain.suppliers).toEqual([]);
    expect(chain.totals).toEqual({ customers: 2, suppliers: 0 });
    const [listed, contract] = chain.customers;
    expect(listed?.id).toBe(seed.rels.listed);
    expect(listed?.counterparty).toEqual({
      id: seed.cCustomer,
      kind: "listed",
      name: `${tag} Customer`,
      symbol: `${tag}C`,
    });
    expect(listed?.status).toBe("active");
    expect(listed?.valueBasis).toBe("revenue_share");
    expect(listed?.costBucket).toBe("COGS");
    expect(listed?.period).toEqual({ start: "2024-04-01", end: "2025-03-31", fiscalYear: 2025 });
    expect(listed?.estimate).toMatchObject({
      method: "disclosed",
      valueCr: 120,
      lowCr: 110,
      highCr: 130,
      asOf: "2025-06-01",
      modelVersion: 1,
    });
    expect(listed?.contractTotalCr).toBeNull();
    expect(listed?.evidence).toHaveLength(1);
    expect(listed?.evidence[0]).toMatchObject({
      observationId: seed.obs.listed,
      quote: `${tag} customer accounts for 12.5% of revenue`,
      page: 41,
      documentId: seed.docs[0],
      source: "annual_report",
      extractorFamily: "annual_report",
    });
    expect(listed?.evidence[0]?.publishedAt).toEqual(expect.any(String));
    expect(contract?.id).toBe(seed.rels.contract);
    expect(contract?.counterparty).toMatchObject({ kind: "private", symbol: null });
    expect(contract?.estimate).toBeNull();
    expect(contract?.contractTotalCr).toBe(500);
    expect(contract?.evidence.map((e) => e.observationId)).toEqual([
      seed.obs.contract,
      seed.obs.older,
    ]);
    expect(chain.coverage).toMatchObject({
      available: 2,
      read: 1,
      lastReadAt: expect.stringMatching(/^2025-06-02T10:00:00/),
    });
    expect(chain.coverage.families.map((f) => [f.family, f.read, f.available])).toEqual([
      ["annual_report", 1, 1],
      ["order_filing", 0, 1],
    ]);
  });

  it("serves the counterparty side and hides legacy edges", async () => {
    const chain = await supplyChain(ctxOf(db), `${tag}C`);
    expect(chain.customers).toEqual([]);
    expect(chain.suppliers.map((s) => s.id)).toEqual([seed.rels.listed]);
    expect(chain.suppliers[0]?.counterparty.symbol).toBe(`${tag}S`);
    expect(chain.coverage).toMatchObject({ available: 0, read: 0, families: [] });
  });

  it("pages the review queue oldest first with a keyset cursor", async () => {
    const mine = new Set(Object.values(seed.obs));
    const all: number[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 20; i++) {
      const page = await reviewQueue(ctxOf(db), { limit: 1, cursor });
      all.push(...page.items.map((x) => x.observationId).filter((x) => mine.has(x)));
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    expect(all).toEqual([seed.obs.older, seed.obs.contract]);
    const first = await reviewQueue(ctxOf(db), { limit: 100 });
    const item = first.items.find((x) => x.observationId === seed.obs.contract);
    expect(item).toMatchObject({
      focal: { id: seed.supplier, symbol: `${tag}S` },
      supplier: { id: seed.cSupplier, symbol: `${tag}S` },
      customer: { id: seed.cPrivate, kind: "private", symbol: null },
      valueBasis: "contract_total",
      valueCr: 500,
      confidence: 0.95,
      newCounterparty: true,
      extractorFamily: "annual_report",
      period: { start: "2024-04-01", end: "2025-03-31", fiscalYear: 2025 },
      evidence: { quote: `${tag} order worth Rs 500 crore from Private Works`, page: 3 },
    });
    expect(item?.createdAt).toBe("2020-01-02T00:00:00.000000Z");
  });

  it("rejects malformed cursors", async () => {
    await expect(reviewQueue(ctxOf(db), { cursor: "not-a-cursor" })).rejects.toMatchObject({
      status: 400,
    });
  });

  it("applies a decision through review_relationship on a read-only session", async () => {
    const [mode] = await readOnly.execute<{ default_transaction_read_only: string }>(
      sql`show default_transaction_read_only`,
    );
    expect(mode?.default_transaction_read_only).toBe("on");
    invalidated.length = 0;
    const res = await reviewRelationship(
      ctxOf(readOnly),
      { observationId: seed.obs.contract, decision: "confirm", note: " checked filing " },
      "operator",
    );
    expect(res).toMatchObject({
      observationStatus: "confirmed",
      relationshipId: seed.rels.contract,
    });
    expect(res.reviewId).toBeGreaterThan(0);
    expect(invalidated).toEqual([supplyChainKey(seed.supplier)]);
    const [review] = await db.execute<{ note: string; reviewer: string }>(sql`
      select note, reviewer from relationship_reviews where id = ${res.reviewId}`);
    expect(review).toEqual({ note: "checked filing", reviewer: "operator" });
    const page = await reviewQueue(ctxOf(db), { limit: 100 });
    expect(page.items.some((x) => x.observationId === seed.obs.contract)).toBe(false);
  });

  it("invalidates both companies when blocking a listed pair", async () => {
    invalidated.length = 0;
    const res = await reviewRelationship(
      ctxOf(readOnly),
      { observationId: seed.obs.confident, decision: "block" },
      "operator",
    );
    expect(res.observationStatus).toBe("blocked");
    expect(invalidated.sort()).toEqual(
      [supplyChainKey(seed.supplier), supplyChainKey(seed.customer)].sort(),
    );
    const chain = await supplyChain(ctxOf(db), `${tag}S`);
    expect(chain.customers.map((c) => c.id)).toEqual([seed.rels.contract]);
  });

  it("maps a missing observation to 404", async () => {
    await expect(
      reviewRelationship(
        ctxOf(readOnly),
        { observationId: 2 ** 52, decision: "reject" },
        "operator",
      ),
    ).rejects.toMatchObject({ status: 404 });
  });
});
