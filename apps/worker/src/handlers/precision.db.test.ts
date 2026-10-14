import { createHash, randomUUID } from "node:crypto";
import { closeDb, createDb, type Db, sql } from "@ma/db";
import { NonRetryableError } from "@ma/jobs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WorkerContext } from "../context.js";
import { precisionHandlers } from "./precision.js";

const url = process.env.DATABASE_URL_TEST;

type Id = { id: number };

describe.skipIf(!url)("relationships.sample (DATABASE_URL_TEST)", () => {
  let db: Db;
  const tag = `p${randomUUID().slice(0, 8)}`;
  const seed = {
    company: 0,
    document: 0,
    revision: 0,
    extractions: { annual_report: 0, concall: 0 },
    parties: { supplier: 0, active: 0, expired: 0 },
    rels: [] as number[],
    eligible: [] as number[],
    ineligible: [] as number[],
  };

  const list = (xs: number[]) =>
    sql.join(
      xs.map((x) => sql`${x}`),
      sql`, `,
    );

  async function one(q: ReturnType<typeof sql>): Promise<number> {
    const [row] = await db.execute<Id>(q);
    if (!row) throw new Error("insert returned no row");
    return Number(row.id);
  }

  async function observation(o: {
    family: "annual_report" | "concall";
    customer: number;
    status: string;
    bucket?: string;
  }): Promise<number> {
    return one(sql`
      insert into relationship_observations (extraction_id, focal_company_id,
        supplier_counterparty_id, customer_counterparty_id, disclosed_by, disclosure_kind,
        cost_bucket, cue_class, claim, confidence, status)
      values (${seed.extractions[o.family]}, ${seed.company}, ${seed.parties.supplier},
              ${o.customer}, 'supplier', 'major_customer', ${o.bucket ?? "COGS"}::cost_bucket,
              'customer', ${`${tag} claim`}, 0.9, ${o.status}::observation_status)
      returning id`);
  }

  async function edge(customer: number, status: string): Promise<number> {
    return one(sql`
      insert into relationships (supplier_name, customer_name, supplier_counterparty_id,
        customer_counterparty_id, edge_key, cost_bucket, disclosed_by, disclosure_kind,
        valid_from, valid_to, confidence, extractor_family, status)
      values (${`${tag}-S`}, ${`${tag}-C-${customer}`}, ${seed.parties.supplier}, ${customer},
              ${`${tag}:${customer}`}, 'COGS', 'supplier', 'major_customer', '2024-04-01',
              '2029-03-31', 0.9, 'annual_report', ${status}::relationship_status)
      returning id`);
  }

  function run(payload: Record<string, unknown>) {
    return precisionHandlers["relationships.sample"]({
      ctx: { db } as unknown as WorkerContext,
      type: "relationships.sample",
      payload,
      attempt: 1,
      campaignId: null,
      deadline: Date.now() + 60_000,
      signal: new AbortController().signal,
      fence: undefined,
      expired: () => false,
    } as never);
  }

  async function items(name: string): Promise<{ id: number; position: number; family: string }[]> {
    const rows = await db.execute<{ id: number; position: number; family: string }>(sql`
      select i.observation_id as id, i.position, ex.extractor_family as family
      from relationship_precision_sample_items i
      join relationship_precision_samples s on s.id = i.sample_id
      join relationship_observations o on o.id = i.observation_id
      join relationship_extractions ex on ex.id = o.extraction_id
      where s.name = ${name}
      order by i.position`);
    return rows.map((r) => ({ id: Number(r.id), position: Number(r.position), family: r.family }));
  }

  const md5 = (s: string) => createHash("md5").update(s).digest("hex");

  beforeAll(async () => {
    db = createDb(url ?? "", 1);
    seed.company = await one(sql`
      insert into companies (name, normalized_name) values (${tag}, ${tag}) returning id`);
    for (const key of ["supplier", "active", "expired"] as const)
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
    for (const family of ["annual_report", "concall"] as const)
      seed.extractions[family] = await one(sql`
        insert into relationship_extractions (document_revision_id, company_id, extractor_family,
          extractor_version, inputs_hash, status)
        values (${seed.revision}, ${seed.company}, ${family}, 3, ${tag}, 'succeeded')
        returning id`);
    seed.rels = [
      await edge(seed.parties.active, "active"),
      await edge(seed.parties.expired, "expired"),
    ];
    for (const status of ["auto", "auto", "auto", "auto", "confirmed", "rejected"])
      seed.eligible.push(
        await observation({ family: "annual_report", customer: seed.parties.active, status }),
      );
    seed.eligible.push(
      await observation({ family: "concall", customer: seed.parties.active, status: "auto" }),
    );
    for (const o of [
      { status: "pending", customer: seed.parties.active },
      { status: "blocked", customer: seed.parties.active },
      { status: "superseded", customer: seed.parties.active },
      { status: "auto", customer: seed.parties.expired },
      { status: "auto", customer: seed.parties.active, bucket: "CAPEX" },
    ])
      seed.ineligible.push(await observation({ family: "annual_report", ...o }));
  });

  afterAll(async () => {
    if (!db) return;
    await db.execute(sql`delete from relationship_precision_samples where name like ${`${tag}%`}`);
    const obs = [...seed.eligible, ...seed.ineligible];
    if (obs.length)
      await db.execute(sql`delete from relationship_observations where id in (${list(obs)})`);
    if (seed.rels.length)
      await db.execute(sql`delete from relationships where id in (${list(seed.rels)})`);
    await db.execute(sql`delete from relationship_extractions where inputs_hash = ${tag}`);
    if (seed.revision)
      await db.execute(sql`delete from document_revisions where id = ${seed.revision}`);
    if (seed.document) await db.execute(sql`delete from documents where id = ${seed.document}`);
    await db.execute(sql`delete from counterparties where canonical_name like ${`${tag}%`}`);
    if (seed.company) await db.execute(sql`delete from companies where id = ${seed.company}`);
    await closeDb(db);
  });

  it("samples auto and reviewed observations behind active edges in md5 order", async () => {
    const name = `${tag}-all`;
    const r = await run({ name, size: 500 });
    expect(r.metrics).toMatchObject({ created: 1 });
    const sampled = await items(name);
    expect(r.metrics.items).toBe(sampled.length);
    expect(sampled.map((s) => s.position)).toEqual(sampled.map((_, i) => i + 1));
    const ids = new Set(sampled.map((s) => s.id));
    for (const id of seed.eligible) expect(ids.has(id), `eligible ${id}`).toBe(true);
    for (const id of seed.ineligible) expect(ids.has(id), `ineligible ${id}`).toBe(false);
    const ranks = sampled.map((s) => md5(`${name}${s.id}`));
    expect(ranks).toEqual([...ranks].sort());
    const [row] = await db.execute<{ size: number; seed: string; family: string | null }>(sql`
      select size, seed, extractor_family as family from relationship_precision_samples
      where name = ${name}`);
    expect(row).toEqual({ size: sampled.length, seed: name, family: null });
  });

  it("draws the same sample for the same seed", async () => {
    await run({ name: `${tag}-a`, size: 3, seed: "gate" });
    await run({ name: `${tag}-b`, size: 3, seed: "gate" });
    const a = await items(`${tag}-a`);
    expect(a).toHaveLength(3);
    expect(await items(`${tag}-b`)).toEqual(a);
    const ranks = a.map((s) => md5(`gate${s.id}`));
    expect(ranks).toEqual([...ranks].sort());
  });

  it("filters by extractor family", async () => {
    const name = `${tag}-concall`;
    const r = await run({ name, size: 500, family: "concall" });
    const sampled = await items(name);
    expect(r.metrics.items).toBe(sampled.length);
    expect(new Set(sampled.map((s) => s.family))).toEqual(new Set(["concall"]));
    const mine = sampled.filter((s) => [...seed.eligible, ...seed.ineligible].includes(s.id));
    expect(mine.map((s) => s.id)).toEqual([seed.eligible.at(-1)]);
  });

  it("is a no-op for an existing name and stays frozen", async () => {
    const name = `${tag}-frozen`;
    const first = await run({ name, size: 2 });
    const before = await items(name);
    const late = await observation({
      family: "annual_report",
      customer: seed.parties.active,
      status: "auto",
    });
    seed.eligible.push(late);
    const again = await run({ name, size: 500, seed: "other" });
    expect(again.metrics).toEqual({ sample: first.metrics.sample, items: 2, created: 0 });
    expect(await items(name)).toEqual(before);
  });

  it("refuses to draw from an empty population", async () => {
    const name = `${tag}-empty`;
    await expect(run({ name, family: "manual" })).rejects.toBeInstanceOf(NonRetryableError);
    expect(
      await db.execute(sql`select 1 from relationship_precision_samples where name = ${name}`),
    ).toHaveLength(0);
  });
});
