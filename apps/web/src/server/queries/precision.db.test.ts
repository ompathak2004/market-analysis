import { randomUUID } from "node:crypto";
import { AppError, NotFoundError } from "@ma/core";
import { closeDb, createDb, type Db, sql } from "@ma/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "../context";
import { precisionSummary, sampleQueue, wilsonLowerBound } from "./precision";
import { reviewRelationship } from "./reviews";

const url = process.env.DATABASE_URL_TEST;

type Id = { id: number };

describe.skipIf(!url)("SPLC precision sample read model (DATABASE_URL_TEST)", () => {
  let db: Db;
  let readOnly: Db;
  const tag = `q${randomUUID().slice(0, 8)}`;
  const gate = `${tag}-gate`;
  const pass = `${tag}-pass`;
  const seed = {
    company: 0,
    document: 0,
    revision: 0,
    extraction: 0,
    parties: { supplier: 0, a: 0, b: 0 },
    a: [] as number[],
    b: [] as number[],
    confirmed: [] as number[],
  };

  const ctxOf = (d: Db) =>
    ({
      db: d,
      api: {
        getOrLoad: <T>(_k: string, load: () => Promise<T>) => load(),
        invalidatePrefix: async () => 0,
      },
      logger: { warn: () => undefined },
    }) as unknown as AppContext;

  async function one(q: ReturnType<typeof sql>): Promise<number> {
    const [row] = await db.execute<Id>(q);
    if (!row) throw new Error("insert returned no row");
    return Number(row.id);
  }

  async function observations(customer: number, status: string, n: number): Promise<number[]> {
    const rows = await db.execute<Id>(sql`
      insert into relationship_observations (extraction_id, focal_company_id,
        supplier_counterparty_id, customer_counterparty_id, disclosed_by, disclosure_kind,
        cost_bucket, cue_class, claim, confidence, status)
      select ${seed.extraction}, ${seed.company}, ${seed.parties.supplier}, ${customer},
             'supplier', 'major_customer', 'COGS', 'customer', ${`${tag} claim `} || g, 0.9,
             ${status}::observation_status
      from generate_series(1, ${n}) g
      returning id`);
    return rows.map((r) => Number(r.id)).sort((x, y) => x - y);
  }

  async function sample(name: string, ids: number[]) {
    const id = await one(sql`
      insert into relationship_precision_samples (name, size, seed)
      values (${name}, ${ids.length}, ${name}) returning id`);
    await db.execute(sql`
      insert into relationship_precision_sample_items (sample_id, observation_id, position)
      select ${id}, x.id, x.position
      from unnest(${`{${ids.join(",")}}`}::bigint[]) with ordinality as x(id, position)`);
  }

  const review = (observationId: number, decision: "confirm" | "reject" | "block") =>
    reviewRelationship(ctxOf(db), { observationId, decision }, "precision-test");

  beforeAll(async () => {
    db = createDb(url ?? "", 2);
    readOnly = createDb(
      `${url}${(url ?? "").includes("?") ? "&" : "?"}default_transaction_read_only=on`,
      1,
    );
    seed.company = await one(sql`
      insert into companies (name, normalized_name) values (${tag}, ${tag}) returning id`);
    for (const key of ["supplier", "a", "b"] as const)
      seed.parties[key] = await one(sql`
        insert into counterparties (kind, canonical_name, normalized_name)
        values ('private', ${`${tag} ${key}`}, ${`${tag} ${key}`}) returning id`);
    seed.document = await one(sql`
      insert into documents (url, source, company_id, sha256, byte_size)
      values (${`https://${tag}.test/ar.pdf`}, 'annual_report', ${seed.company}, 'x', 1)
      returning id`);
    seed.revision = await one(sql`
      insert into document_revisions (document_id, content_sha256, text_bytes)
      values (${seed.document}, ${tag}, 1) returning id`);
    seed.extraction = await one(sql`
      insert into relationship_extractions (document_revision_id, company_id, extractor_family,
        extractor_version, inputs_hash, status)
      values (${seed.revision}, ${seed.company}, 'annual_report', 3, ${tag}, 'succeeded')
      returning id`);
    for (const customer of [seed.parties.a, seed.parties.b])
      await db.execute(sql`
        insert into relationships (supplier_name, customer_name, supplier_counterparty_id,
          customer_counterparty_id, edge_key, cost_bucket, disclosed_by, disclosure_kind,
          valid_from, valid_to, confidence, extractor_family, status, observation_count)
        values (${`${tag}-S`}, ${`${tag}-C-${customer}`}, ${seed.parties.supplier}, ${customer},
                ${`${tag}:${customer}`}, 'COGS', 'supplier', 'major_customer', '2024-04-01',
                '2029-03-31', 0.9, 'annual_report', 'active', 50)`);
    seed.a = await observations(seed.parties.a, "auto", 6);
    seed.b = await observations(seed.parties.b, "auto", 2);
    seed.confirmed = await observations(seed.parties.a, "confirmed", 40);
    await sample(gate, [...seed.a, ...seed.b]);
    await sample(pass, seed.confirmed);
  });

  afterAll(async () => {
    if (!db) return;
    await db.execute(sql`delete from relationship_precision_samples where name like ${`${tag}%`}`);
    await db.execute(
      sql`delete from relationship_observations where extraction_id = ${seed.extraction}`,
    );
    await db.execute(sql`delete from relationships where edge_key like ${`${tag}:%`}`);
    await db.execute(sql`delete from relationship_extractions where inputs_hash = ${tag}`);
    if (seed.revision)
      await db.execute(sql`delete from document_revisions where id = ${seed.revision}`);
    if (seed.document) await db.execute(sql`delete from documents where id = ${seed.document}`);
    await db.execute(sql`delete from counterparties where canonical_name like ${`${tag}%`}`);
    if (seed.company) await db.execute(sql`delete from companies where id = ${seed.company}`);
    await closeDb(db);
    await closeDb(readOnly);
  });

  it("starts with every item unreviewed and pages the queue by sample position", async () => {
    const summary = await precisionSummary(ctxOf(readOnly), gate);
    expect(summary.sample).toMatchObject({ name: gate, family: null, size: 8, seed: gate });
    expect(summary.sample.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
    expect(summary.counts).toEqual({
      items: 8,
      reviewed: 0,
      confirmed: 0,
      rejected: 0,
      blocked: 0,
      unreviewed: 8,
    });
    expect(summary).toMatchObject({ precision: null, lowerBound: 0, gate: 0.9, passes: false });

    const order = [...seed.a, ...seed.b];
    const seen: number[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 3; page++) {
      const res: Awaited<ReturnType<typeof sampleQueue>> = await sampleQueue(ctxOf(readOnly), {
        name: gate,
        limit: 3,
        cursor,
      });
      seen.push(...res.items.map((i) => i.observationId));
      cursor = res.nextCursor;
    }
    expect(seen).toEqual(order);
    expect(cursor).toBeNull();
    const [first] = (await sampleQueue(ctxOf(readOnly), { name: gate })).items;
    expect(first).toMatchObject({
      observationId: seed.a[0],
      claim: `${tag} claim 1`,
      extractorFamily: "annual_report",
      costBucket: "COGS",
    });
  });

  it("counts the latest decision per observation and blocked siblings", async () => {
    const [a1, a2, a3, a4, a5, a6] = seed.a as [number, number, number, number, number, number];
    const [b1] = seed.b as [number];
    for (const id of [a1, a2, a3]) await review(id, "confirm");
    await review(a4, "reject");
    await review(a4, "confirm");
    await review(b1, "block");

    const summary = await precisionSummary(ctxOf(readOnly), gate);
    expect(summary.counts).toEqual({
      items: 8,
      reviewed: 6,
      confirmed: 4,
      rejected: 0,
      blocked: 2,
      unreviewed: 2,
    });
    expect(summary.precision).toBeCloseTo(4 / 6, 10);
    expect(summary.lowerBound).toBeCloseTo(wilsonLowerBound(4, 6), 10);
    expect(summary.passes).toBe(false);
    const queue = await sampleQueue(ctxOf(readOnly), { name: gate });
    expect(queue.items.map((i) => i.observationId)).toEqual([a5, a6]);
    expect(queue.nextCursor).toBeNull();

    await review(a5, "reject");
    await review(a6, "confirm");
    const done = await precisionSummary(ctxOf(readOnly), gate);
    expect(done.counts).toMatchObject({ reviewed: 8, confirmed: 5, rejected: 1, blocked: 2 });
    expect(done.counts.unreviewed).toBe(0);
    expect(done.precision).toBeCloseTo(5 / 8, 10);
    expect(done.passes).toBe(false);
    expect((await sampleQueue(ctxOf(readOnly), { name: gate })).items).toEqual([]);
  });

  it("passes once every item is labelled and the lower bound clears 90%", async () => {
    const summary = await precisionSummary(ctxOf(readOnly), pass);
    expect(summary.counts).toMatchObject({ items: 40, reviewed: 40, confirmed: 40 });
    expect(summary.precision).toBe(1);
    expect(summary.lowerBound).toBeCloseTo(40 / (40 + 1.96 ** 2), 10);
    expect(summary.passes).toBe(true);

    const [gone] = seed.confirmed;
    await db.execute(sql`delete from relationship_observations where id = ${gone ?? 0}`);
    const shrunk = await precisionSummary(ctxOf(readOnly), pass);
    expect(shrunk.sample.size).toBe(40);
    expect(shrunk.counts).toMatchObject({ items: 39, reviewed: 39, unreviewed: 0 });
    expect(shrunk.lowerBound).toBeGreaterThan(0.9);
    expect(shrunk.passes).toBe(false);
  });

  it("rejects unknown samples and malformed cursors", async () => {
    await expect(precisionSummary(ctxOf(readOnly), `${tag}-missing`)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(await sampleQueue(ctxOf(readOnly), { name: `${tag}-missing` })).toEqual({
      items: [],
      nextCursor: null,
    });
    await expect(
      sampleQueue(ctxOf(readOnly), { name: gate, cursor: "abc" }),
    ).rejects.toBeInstanceOf(AppError);
  });
});
