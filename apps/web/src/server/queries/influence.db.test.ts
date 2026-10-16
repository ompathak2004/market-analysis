import { randomInt, randomUUID } from "node:crypto";
import { closeDb, createDb, type Db, sql } from "@ma/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "../context";
import { influenceFor } from "./influence";

const url = process.env.DATABASE_URL_TEST;

type Id = { id: number };

describe.skipIf(!url)("INFL read model (DATABASE_URL_TEST)", () => {
  let db: Db;
  let readOnly: Db;
  const tag = `I${randomUUID().slice(0, 8).toUpperCase()}`;
  const dins = [randomInt(10_000_000, 99_999_999), randomInt(10_000_000, 99_999_999)].map(String);
  const seed = {
    company: 0,
    subsidiary: 0,
    persons: [] as number[],
    counterparties: [] as number[],
    document: 0,
  };

  const ctxOf = (d: Db) =>
    ({
      db: d,
      api: { getOrLoad: <T>(_k: string, load: () => Promise<T>) => load() },
      logger: { warn: () => undefined },
    }) as unknown as AppContext;

  async function one(q: ReturnType<typeof sql>): Promise<number> {
    const [row] = await db.execute<Id>(q);
    if (!row) throw new Error("insert returned no row");
    return Number(row.id);
  }

  const node = (kind: string, column: "company_id" | "person_id" | "counterparty_id", id: number) =>
    one(sql`insert into graph_nodes (kind, ${sql.raw(column)})
            values (${kind}::graph_node_kind, ${id}) returning id`);

  async function edge(
    from: number,
    to: number,
    kind: string,
    status: string,
    confidence: number,
    fact: { role?: number; rpt?: number; ownership?: number },
    validTo: string | null = null,
  ): Promise<number> {
    return one(sql`
      insert into influence_edges (from_node_id, to_node_id, kind, person_role_id, rpt_id,
                                   ownership_id, confidence, status, resolver_version, input_hash,
                                   valid_from, valid_to)
      values (${from}, ${to}, ${kind}::influence_edge_kind, ${fact.role ?? null},
              ${fact.rpt ?? null}, ${fact.ownership ?? null}, ${confidence},
              ${status}::influence_edge_status, 1, ${`${tag}${kind}${to}`}, '2024-04-01', ${validTo})
      returning id`);
  }

  beforeAll(async () => {
    db = createDb(url as string, 2);
    readOnly = createDb(
      `${url}${(url as string).includes("?") ? "&" : "?"}default_transaction_read_only=on`,
      1,
    );
    const company = (sym: string) =>
      one(sql`insert into companies (name, normalized_name, nse_symbol, listing_status)
              values (${`${sym} Ltd`}, ${sym.toLowerCase()}, ${sym}, 'active') returning id`);
    seed.company = await company(tag);
    seed.subsidiary = await company(`${tag}SUB`);
    seed.persons = [
      await one(sql`insert into persons (din, canonical_name, normalized_name)
                    values (${dins[0]}, ${`Asha ${tag}`}, ${`asha ${tag.toLowerCase()}`}) returning id`),
      await one(sql`insert into persons (din, canonical_name, normalized_name)
                    values (${dins[1]}, ${`Ravi ${tag}`}, ${`ravi ${tag.toLowerCase()}`}) returning id`),
    ];
    const cp = (name: string, kind: string, companyId: number | null) =>
      one(sql`insert into counterparties (kind, canonical_name, normalized_name, company_id)
              values (${kind}::counterparty_kind, ${name}, ${name.toLowerCase()}, ${companyId})
              returning id`);
    seed.counterparties = [
      await cp(`${tag} Holdings`, "private", null),
      await cp(`${tag}SUB Ltd`, "listed", seed.subsidiary),
      await cp(`${tag} Pending Traders`, "private", null),
    ];
    const [holding, sub, pendingCp] = seed.counterparties as [number, number, number];
    seed.document = await one(sql`
      insert into documents (url, source, sha256, byte_size, company_id, published_at)
      values (${`https://example.test/${tag}/gov.xml`}, 'nse_governance', ${`${tag}doc`}, 10,
              ${seed.company}, now() - interval '10 days') returning id`);
    const revision = await one(sql`
      insert into document_revisions (document_id, content_sha256, text_bytes, published_at)
      values (${seed.document}, ${`${tag}rev`}, 100, now() - interval '9 days') returning id`);
    let offset = 0;
    const span = (quote: string) => {
      const start = offset;
      offset += quote.length + 1;
      return one(sql`insert into evidence_spans (document_revision_id, start_offset, end_offset, quote, page)
              values (${revision}, ${start}, ${start + quote.length}, ${quote}, null) returning id`);
    };

    const cNode = await node("company", "company_id", seed.company);
    const [asha, ravi] = seed.persons as [number, number];
    const ashaNode = await node("person", "person_id", asha);
    const raviNode = await node("person", "person_id", ravi);
    const holdingNode = await node("counterparty", "counterparty_id", holding);
    const subNode = await node("counterparty", "counterparty_id", sub);
    const pendingNode = await node("counterparty", "counterparty_id", pendingCp);

    const role = (person: number, kind: string, status: string, toDate: string | null) =>
      one(sql`insert into person_roles (person_id, company_id, role, category, from_date, to_date,
                                        status, dedupe_key)
              values (${person}, ${seed.company}, ${kind}::person_role_kind, 'Executive Director',
                      '2024-04-01', ${toDate}, ${status}::influence_fact_status,
                      ${`nse_governance:${seed.company}:${person}`}) returning id`);
    const ashaRole = await role(asha, "chairman", "current", null);
    const raviRole = await role(ravi, "independent_director", "past", "2025-06-30");
    const ashaEdge = await edge(ashaNode, cNode, "director_of", "confirmed", 0.98, {
      role: ashaRole,
    });
    const raviEdge = await edge(
      raviNode,
      cNode,
      "director_of",
      "confirmed",
      0.98,
      { role: raviRole },
      "2025-06-30",
    );

    const rpt = (cpId: number | null, name: string, type: string, value: string, key: string) =>
      one(sql`insert into related_party_transactions (company_id, counterparty_id, counterparty_name,
                relationship, transaction_type, value_cr, period_start, period_end, scope, source,
                dedupe_key)
              values (${seed.company}, ${cpId}, ${name}, 'Holding company', ${type}, ${value},
                      '2025-04-01', '2025-09-30', 'standalone', 'nse_rpt',
                      ${`nse_rpt:${seed.company}:2025-09-30:${tag}${key}`}) returning id`);
    const bigRpt = await rpt(holding, `${tag} Holdings`, "Purchase of goods", "120.50", "a");
    await rpt(holding, `${tag} Holdings`, "Dividend paid", "30.00", "b");
    const pendingRpt = await rpt(pendingCp, `${tag} Pending Traders`, "Sale of goods", "5.00", "c");
    const rptEdge = await edge(cNode, holdingNode, "related_party", "confirmed", 0.95, {
      rpt: bigRpt,
    });
    await edge(cNode, pendingNode, "related_party", "pending", 0.8, { rpt: pendingRpt });
    const promoterEdge = await edge(holdingNode, cNode, "promoter_of", "confirmed", 0.95, {});
    await edge(pendingNode, cNode, "promoter_of", "confirmed", 0.95, {});
    const own = await one(sql`
      insert into ownership (holder_node_id, target_node_id, pct, as_of, source)
      values (${cNode}, ${subNode}, 74.5, '2025-09-30', 'nse_rpt') returning id`);
    const ownEdge = await edge(cNode, subNode, "owns", "confirmed", 0.95, { ownership: own });

    const spans = [
      await span(`${tag} Asha is the Chairperson`),
      await span(`${tag} Holdings purchase of goods 120.50`),
      await span(`${tag} Ravi ceased as director`),
      await span(`${tag} Holdings is the promoter`),
      await span(`${tag} owns 74.5% of the subsidiary`),
    ];
    await db.execute(sql`insert into influence_edge_evidence (edge_id, evidence_span_id)
      values (${ashaEdge}, ${spans[0]}), (${rptEdge}, ${spans[1]}),
             (${raviEdge}, ${spans[2]}), (${promoterEdge}, ${spans[3]}), (${ownEdge}, ${spans[4]})`);

    await db.execute(sql`
      insert into influence_events (company_id, kind, occurred_at, summary, rule_version, input_hash)
      values (${seed.company}, 'director_change', now() - interval '2 days',
              ${`Ravi ${tag} is no longer listed on the board`}, 1, ${`${tag}e1`}),
             (${seed.company}, 'material_rpt', now() - interval '1 day',
              ${`${tag} Holdings: Purchase of goods ₹120.50 Cr`}, 1, ${`${tag}e2`})`);
    await db.execute(sql`
      insert into influence_coverage (company_id, governance_read_at, rpt_read_at, resolver_version)
      values (${seed.company}, now() - interval '1 day', now() - interval '1 day', 1)`);
  });

  afterAll(async () => {
    if (!db) return;
    const ids = (xs: number[]) =>
      sql.join(
        xs.filter(Boolean).map((x) => sql`${x}`),
        sql`, `,
      );
    await db.execute(sql`delete from influence_edges where input_hash like ${`${tag}%`}`);
    await db.execute(sql`delete from ownership where source = 'nse_rpt'
      and holder_node_id in (select id from graph_nodes where company_id = ${seed.company})`);
    await db.execute(sql`delete from graph_nodes
      where company_id in (${ids([seed.company, seed.subsidiary])})
         or person_id in (${ids(seed.persons)})
         or counterparty_id in (${ids(seed.counterparties)})`);
    await db.execute(sql`delete from documents where id = ${seed.document}`);
    await db.execute(sql`delete from counterparties where id in (${ids(seed.counterparties)})`);
    await db.execute(
      sql`delete from companies where id in (${ids([seed.company, seed.subsidiary])})`,
    );
    await db.execute(sql`delete from persons where id in (${ids(seed.persons)})`);
    await closeDb(db);
    await closeDb(readOnly);
  });

  it("returns confirmed board, promoters and related entities with evidence over a read-only pool", async () => {
    const res = await influenceFor(ctxOf(readOnly), tag.toLowerCase());
    expect(res.schemaVersion).toBe(1);
    expect(res.company).toEqual({ id: seed.company, symbol: tag });

    expect(res.board.map((d) => [d.name, d.role, d.status])).toEqual([
      [`Asha ${tag}`, "chairman", "current"],
      [`Ravi ${tag}`, "independent_director", "past"],
    ]);
    const asha = res.board[0];
    expect(asha?.din).toBe(dins[0]);
    expect(asha?.evidence).toHaveLength(1);
    expect(asha?.evidence[0]).toMatchObject({
      quote: `${tag} Asha is the Chairperson`,
      source: "nse_governance",
      url: `https://example.test/${tag}/gov.xml`,
    });
    expect(res.board[1]?.validTo).toBe("2025-06-30");

    expect(res.promoters).toHaveLength(1);
    expect(res.promoters[0]).toMatchObject({ name: `${tag} Holdings`, nodeKind: "counterparty" });

    expect(res.related.map((r) => [r.kind, r.name])).toEqual([
      ["related_party", `${tag} Holdings`],
      ["owns", `${tag}SUB Ltd`],
    ]);
    const holding = res.related[0];
    expect(holding).toMatchObject({
      transactionType: "Purchase of goods",
      valueCr: 120.5,
      totalCr: 150.5,
      transactions: 2,
      periodEnd: "2025-09-30",
      counterpartyKind: "private",
    });
    expect(holding?.evidence[0]?.quote).toContain("purchase of goods");
    expect(res.related[1]).toMatchObject({ pct: 74.5, symbol: `${tag}SUB`, asOf: "2025-09-30" });
    expect(res.related.some((r) => r.name.includes("Pending"))).toBe(false);

    expect(res.paths).toEqual([]);
    expect(res.policy).toEqual([]);
  });

  it("orders the change feed newest first and reports coverage counts without pending details", async () => {
    const res = await influenceFor(ctxOf(readOnly), tag);
    expect(res.events.map((e) => e.kind)).toEqual(["material_rpt", "director_change"]);
    expect(res.events.every((e) => e.reviewed)).toBe(true);
    expect(res.coverage).toMatchObject({
      resolverVersion: 1,
      perimeterReadAt: null,
      confirmed: 5,
      pending: 1,
      pendingByKind: [{ kind: "related_party", count: 1 }],
      directorsListed: 1,
      rptRows: 3,
      rptPeriodEnd: "2025-09-30",
    });
    expect(res.coverage.governanceReadAt).not.toBeNull();
  });
});
