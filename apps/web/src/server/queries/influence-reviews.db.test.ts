import { randomUUID } from "node:crypto";
import { AppError } from "@ma/core";
import { closeDb, createDb, type Db, sql } from "@ma/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "../context";
import { confirmedPaths, influenceKey } from "./influence";
import { influenceReviewQueue, reviewInfluenceEdge } from "./influence-reviews";
import { encodeCursor } from "./reviews";

const url = process.env.DATABASE_URL_TEST;

type Id = { id: number };

describe.skipIf(!url)("INFL political paths and review (DATABASE_URL_TEST)", () => {
  let db: Db;
  let readOnly: Db;
  let since = "";
  const tag = `P${randomUUID().slice(0, 8).toUpperCase()}`;
  const invalidated: string[] = [];
  const seed = { company: 0, persons: [] as number[], document: 0, pendingOffice: 0, uncited: 0 };

  const ctxOf = (d: Db) =>
    ({
      db: d,
      api: {
        getOrLoad: <T>(_k: string, load: () => Promise<T>) => load(),
        invalidatePrefix: async (k: string) => {
          invalidated.push(k);
        },
      },
      logger: { warn: () => undefined },
    }) as unknown as AppContext;

  async function one(q: ReturnType<typeof sql>): Promise<number> {
    const [row] = await db.execute<Id>(q);
    if (!row) throw new Error("insert returned no row");
    return Number(row.id);
  }

  beforeAll(async () => {
    db = createDb(url as string, 2);
    readOnly = createDb(
      `${url}${(url as string).includes("?") ? "&" : "?"}default_transaction_read_only=on`,
      1,
    );
    const [clock] = await db.execute<{ at: string }>(
      sql`select to_char((now() - interval '1 second') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at`,
    );
    since = clock?.at ?? "";
    seed.company = await one(sql`
      insert into companies (name, normalized_name, nse_symbol, listing_status)
      values (${`${tag} Ltd`}, ${tag.toLowerCase()}, ${tag}, 'active') returning id`);
    const person = (name: string) =>
      one(sql`insert into persons (canonical_name, normalized_name)
              values (${`${name} ${tag}`}, ${`${name.toLowerCase()} ${tag.toLowerCase()}`})
              returning id`);
    seed.persons = [await person("Meera"), await person("Kabir")];
    const [meera, kabir] = seed.persons as [number, number];

    seed.document = await one(sql`
      insert into documents (url, source, sha256, byte_size, published_at)
      values (${`https://example.test/${tag}/members.json`}, 'sansad', ${`${tag}doc`}, 10,
              now() - interval '3 days') returning id`);
    const revision = await one(sql`
      insert into document_revisions (document_id, content_sha256, text_bytes, published_at)
      values (${seed.document}, ${`${tag}rev`}, 100, now() - interval '3 days') returning id`);
    let offset = 0;
    const span = (quote: string) => {
      const start = offset;
      offset += quote.length + 1;
      return one(sql`insert into evidence_spans (document_revision_id, start_offset, end_offset,
                                                 quote, page)
                     values (${revision}, ${start}, ${start + quote.length}, ${quote}, null)
                     returning id`);
    };

    const node = (kind: string, column: string, value: number | string) =>
      one(sql`insert into graph_nodes (kind, ${sql.raw(column)})
              values (${kind}::graph_node_kind, ${value}) returning id`);
    const cNode = await node("company", "company_id", seed.company);
    const meeraNode = await node("person", "person_id", meera);
    const kabirNode = await node("person", "person_id", kabir);
    const houseNode = await node("party", "party_name", `Lok Sabha ${tag}`);
    const partyNode = await node("party", "party_name", `Party ${tag}`);

    const edge = async (
      from: number,
      to: number,
      kind: string,
      status: string,
      confidence: number,
      quote: string | null,
      validTo: string | null = null,
    ) => {
      const id = await one(sql`
        insert into influence_edges (from_node_id, to_node_id, kind, confidence, status,
                                     resolver_version, input_hash, valid_from, valid_to)
        values (${from}, ${to}, ${kind}::influence_edge_kind, ${confidence},
                ${status}::influence_edge_status, 1, ${`${tag}${kind}${from}${to}`},
                '2024-06-04', ${validTo})
        returning id`);
      if (quote) {
        const s = await span(quote);
        await db.execute(sql`insert into influence_edge_evidence (edge_id, evidence_span_id)
                             values (${id}, ${s})`);
      }
      return id;
    };

    seed.uncited = await edge(meeraNode, cNode, "promoter_of", "pending", 0.8, null);
    await edge(meeraNode, cNode, "director_of", "confirmed", 0.98, `Meera ${tag} Director`);
    await edge(meeraNode, houseNode, "holds_office", "confirmed", 0.95, `Meera ${tag} MP`);
    await edge(meeraNode, partyNode, "member_of_party", "confirmed", 0.95, null);
    await edge(kabirNode, cNode, "director_of", "confirmed", 0.98, `Kabir ${tag} Director`);
    seed.pendingOffice = await edge(
      kabirNode,
      houseNode,
      "holds_office",
      "pending",
      0.8,
      `Kabir ${tag} Member of Parliament`,
    );
    await edge(
      kabirNode,
      partyNode,
      "member_of_party",
      "confirmed",
      0.95,
      `Kabir ${tag} party`,
      "2025-01-01",
    );
    await edge(cNode, partyNode, "donated_to", "confirmed", 0.95, `${tag} Ltd bond`, "2025-01-01");
  });

  afterAll(async () => {
    if (!db) return;
    await db.execute(sql`delete from influence_edges where input_hash like ${`${tag}%`}`);
    await db.execute(sql`delete from graph_nodes
      where company_id = ${seed.company}
         or person_id in (${sql.join(
           seed.persons.map((p) => sql`${p}`),
           sql`, `,
         )})
         or party_name like ${`%${tag}`}`);
    await db.execute(sql`delete from documents where id = ${seed.document}`);
    await db.execute(sql`delete from companies where id = ${seed.company}`);
    await db.execute(
      sql`delete from persons where id in (${sql.join(
        seed.persons.map((p) => sql`${p}`),
        sql`, `,
      )})`,
    );
    await closeDb(db);
    await closeDb(readOnly);
  });

  it("returns only current chains whose every hop is confirmed and cited", async () => {
    const paths = await confirmedPaths(ctxOf(readOnly), seed.company);
    expect(paths.map((p) => p.terminal)).toEqual(["donated_to", "holds_office"]);
    const [donation, path] = paths;
    expect(donation?.nodes.map((n) => n.label)).toEqual([`${tag} Ltd`, `Party ${tag}`]);
    expect(donation?.hops[0]).toMatchObject({ forward: true, validFrom: "2024-06-04" });
    expect(path?.terminal).toBe("holds_office");
    expect(path?.nodes.map((n) => n.label)).toEqual([
      `${tag} Ltd`,
      `Meera ${tag}`,
      `Lok Sabha ${tag}`,
    ]);
    expect(path?.hops.map((h) => [h.kind, h.forward])).toEqual([
      ["director_of", false],
      ["holds_office", true],
    ]);
    expect(path?.hops.every((h) => h.evidence.length > 0)).toBe(true);
  });

  it("lists pending edges with endpoints and evidence for review", async () => {
    const page = await influenceReviewQueue(ctxOf(readOnly), {
      limit: 100,
      cursor: encodeCursor({ createdAt: since, id: 1 }),
    });
    const item = page.items.find((i) => i.edgeId === seed.pendingOffice);
    expect(item).toMatchObject({
      kind: "holds_office",
      version: 1,
      confidence: 0.8,
      from: { kind: "person", label: `Kabir ${tag}`, symbol: null },
      to: { kind: "party", label: `Lok Sabha ${tag}` },
    });
    expect(item?.evidence[0]).toMatchObject({
      quote: `Kabir ${tag} Member of Parliament`,
      source: "sansad",
    });
    expect(page.items.some((i) => i.from.label.includes(tag) && i.kind === "director_of")).toBe(
      false,
    );
  });

  it("filters political review items without including promoter seeds", async () => {
    const page = await influenceReviewQueue(ctxOf(readOnly), { limit: 100, political: true });
    expect(page.items.some((i) => i.edgeId === seed.pendingOffice)).toBe(true);
    expect(page.items.some((i) => i.edgeId === seed.uncited)).toBe(false);
    expect(
      page.items.every((i) =>
        [
          "holds_office",
          "member_of_party",
          "declared_interest",
          "declared_family",
          "donated_to",
        ].includes(i.kind),
      ),
    ).toBe(true);
  });

  it("refuses uncited confirmation without recording a decision and still permits rejection", async () => {
    const res = await reviewInfluenceEdge(
      ctxOf(readOnly),
      { edgeId: seed.uncited, decision: "confirm", version: 1 },
      "operator",
    ).catch((e: unknown) => e);
    expect(res).toBeInstanceOf(AppError);
    expect((res as AppError).status).toBe(400);
    const [row] = await db.execute<{ status: string; version: number; reviews: number }>(sql`
      select status, version, (select count(*)::int from influence_reviews where edge_id = e.id) as reviews
      from influence_edges e where id = ${seed.uncited}`);
    expect(row).toEqual({ status: "pending", version: 1, reviews: 0 });
    expect(
      await reviewInfluenceEdge(
        ctxOf(readOnly),
        { edgeId: seed.uncited, decision: "reject", version: 1 },
        "operator",
      ),
    ).toMatchObject({ status: "rejected", version: 2 });
  });

  it("rejects a stale version, confirms with the current one and invalidates the company", async () => {
    const ctx = ctxOf(readOnly);
    const stale = await reviewInfluenceEdge(
      ctx,
      { edgeId: seed.pendingOffice, decision: "confirm", version: 7 },
      "operator",
    ).catch((e: unknown) => e);
    expect(stale).toBeInstanceOf(AppError);
    expect((stale as AppError).status).toBe(409);

    const missing = await reviewInfluenceEdge(
      ctx,
      { edgeId: 2_000_000_000, decision: "reject", version: 1 },
      "operator",
    ).catch((e: unknown) => e);
    expect((missing as AppError).status).toBe(404);

    const res = await reviewInfluenceEdge(
      ctx,
      { edgeId: seed.pendingOffice, decision: "confirm", version: 1, note: " sansad " },
      "operator",
    );
    expect(res).toMatchObject({ status: "confirmed", version: 2 });
    expect(invalidated).toContain(influenceKey(seed.company));

    const paths = await confirmedPaths(ctx, seed.company);
    expect(
      paths
        .filter((p) => p.terminal === "holds_office")
        .map((p) => p.nodes[1]?.label)
        .sort(),
    ).toEqual([`Kabir ${tag}`, `Meera ${tag}`]);
    const [review] = await db.execute<{ note: string; edge_version: number }>(
      sql`select note, edge_version from influence_reviews where edge_id = ${seed.pendingOffice}`,
    );
    expect(review).toEqual({ note: "sansad", edge_version: 1 });
  });
});
