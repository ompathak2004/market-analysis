import { randomInt, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createLogger } from "@ma/core";
import {
  and,
  closeDb,
  companies,
  counterparties,
  createDb,
  type Db,
  documents,
  eq,
  graphNodes,
  inArray,
  influenceCoverage,
  influenceEdgeEvidence,
  influenceEdges,
  influenceEvents,
  influenceExtractions,
  personRoles,
  persons,
  sql,
} from "@ma/db";
import type { Firecrawl, HttpClient, IngestContext } from "@ma/ingest";
import {
  DocumentStore,
  type GovernanceDirector,
  type GovernanceFiling,
  type GovernanceReport,
  parseGovernanceXbrl,
  parseRptXbrl,
  type RptFiling,
  type RptReport,
} from "@ma/ingest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type GovernanceSourceLike,
  type RptSourceLike,
  syncGovernance,
  syncPerimeter,
  syncRelatedParties,
} from "./pipeline.js";
import { rptRelationshipClass } from "./rules.js";

const url = process.env.DATABASE_URL_TEST;

const fixture = (name: string) =>
  readFileSync(
    new URL(`../../../ingest/src/sources/__fixtures__/${name}`, import.meta.url),
    "utf8",
  );

const governanceSource = (filing: GovernanceFiling, report: () => GovernanceReport) =>
  ({
    filings: async () => [filing],
    report: async () => report(),
  }) satisfies GovernanceSourceLike;

describe.skipIf(!url)("influence pipelines (DATABASE_URL_TEST)", () => {
  let db: Db;
  let ctx: IngestContext;
  let companyId = 0;
  const tag = randomUUID().slice(0, 8);
  const symbol = `INFL${tag.toUpperCase()}`;
  const dinMap = new Map<string, string>();
  const base = parseGovernanceXbrl(fixture("nse-governance.xbrl.xml"));
  const directors: GovernanceDirector[] = base.directors.map((d) => {
    const din = String(randomInt(10_000_000, 99_999_999));
    if (d.din) dinMap.set(d.din, din);
    return { ...d, din };
  });
  const newcomer: GovernanceDirector = {
    din: String(randomInt(10_000_000, 99_999_999)),
    name: `Newcomer ${tag}`,
    title: "Independent Director",
    category: "Non-Executive - Independent Director",
    role: "independent_director",
    independent: true,
    executive: false,
    promoterRelated: false,
    birthYear: null,
    status: "current",
    appointedOn: "2026-06-01",
    reappointedOn: null,
    ceasedOn: null,
  };
  const govFiling: GovernanceFiling = {
    id: `gov-${tag}`,
    kind: "integrated",
    symbol,
    companyName: "TATA CONSULTANCY SERVICES LIMITED",
    periodEnd: "2026-06-30",
    submittedAt: new Date("2026-07-30T05:08:24.000Z"),
    revised: false,
    xbrlUrl: `https://nsearchives.test/${tag}/governance.xml`,
  };
  const rptFiling: RptFiling = {
    id: `rpt-${tag}`,
    kind: "legacy",
    symbol,
    companyName: "TATA CONSULTANCY SERVICES LIMITED",
    periodStart: "2024-04-01",
    periodEnd: "2024-09-30",
    submittedAt: new Date("2024-11-14T10:00:00.000Z"),
    revised: false,
    xbrlUrl: `https://nsearchives.test/${tag}/rpt.xml`,
  };
  let board = directors;
  const independentDin = dinMap.get("03611983") as string;

  const roleRows = () =>
    db
      .select({ din: persons.din, status: personRoles.status, toDate: personRoles.toDate })
      .from(personRoles)
      .innerJoin(persons, eq(persons.id, personRoles.personId))
      .where(eq(personRoles.companyId, companyId));
  const directorEdges = () =>
    db
      .select({
        id: influenceEdges.id,
        status: influenceEdges.status,
        validTo: influenceEdges.validTo,
        personRoleId: influenceEdges.personRoleId,
      })
      .from(influenceEdges)
      .innerJoin(personRoles, eq(personRoles.id, influenceEdges.personRoleId))
      .where(and(eq(personRoles.companyId, companyId), eq(influenceEdges.kind, "director_of")));
  const events = () =>
    db
      .select({ kind: influenceEvents.kind, summary: influenceEvents.summary })
      .from(influenceEvents)
      .where(eq(influenceEvents.companyId, companyId))
      .orderBy(influenceEvents.id);

  beforeAll(async () => {
    db = createDb(url as string, 1);
    const logger = createLogger("test", "error");
    ctx = {
      db,
      docs: new DocumentStore(db, {} as HttpClient, {} as Firecrawl, logger, null),
      logger,
      config: { NSE_BASE_URL: "https://www.nseindia.test" },
    } as unknown as IngestContext;
    const [company] = await db
      .insert(companies)
      .values({
        name: `Tata Consultancy Services ${tag}`,
        normalizedName: `tata consultancy services ${tag}`,
        nseSymbol: symbol,
      })
      .returning({ id: companies.id });
    companyId = company?.id ?? 0;
  });

  afterAll(async () => {
    const dins = [...dinMap.values(), newcomer.din as string];
    await db.delete(companies).where(eq(companies.id, companyId));
    await db.delete(persons).where(inArray(persons.din, dins));
    await db.delete(counterparties).where(sql`${counterparties.normalizedName} like ${`%${tag}%`}`);
    await db
      .delete(documents)
      .where(sql`${documents.url} like ${`https://nsearchives.test/${tag}/%`}`);
    await closeDb(db);
  });

  it("writes persons, roles and confirmed director edges with evidence", async () => {
    const r = await syncGovernance(ctx, companyId, {
      source: governanceSource(govFiling, () => ({ ...base, directors: board })),
    });
    expect(r).toMatchObject({ status: "updated", changed: true, rows: 4, events: 0, skipped: 0 });

    const roles = await roleRows();
    expect(roles).toHaveLength(4);
    expect(roles.filter((x) => x.status === "current")).toHaveLength(3);
    const past = roles.find((x) => x.status === "past");
    expect(past?.toDate).toBe("2026-05-15");

    const edges = await directorEdges();
    expect(edges).toHaveLength(4);
    expect(edges.every((e) => e.status === "confirmed")).toBe(true);
    expect(edges.filter((e) => e.validTo === "2026-05-15")).toHaveLength(1);

    const evidence = await db
      .select({ edgeId: influenceEdgeEvidence.edgeId })
      .from(influenceEdgeEvidence)
      .where(
        inArray(
          influenceEdgeEvidence.edgeId,
          edges.map((e) => e.id),
        ),
      );
    expect(evidence).toHaveLength(4);

    const confirmed = await db.execute<{ from_label: string; to_symbol: string; from_din: string }>(
      sql`select from_label, to_symbol, from_din from influence_edges_confirmed
          where kind = 'director_of' and to_company_id = ${companyId} order by from_din`,
    );
    expect(confirmed).toHaveLength(4);
    expect(confirmed.every((c) => c.to_symbol === symbol)).toBe(true);
    expect(confirmed.map((c) => c.from_din)).toContain(independentDin);

    const [coverage] = await db
      .select()
      .from(influenceCoverage)
      .where(eq(influenceCoverage.companyId, companyId));
    expect(coverage?.governanceReadAt).toBeInstanceOf(Date);
    expect(await events()).toHaveLength(0);
  });

  it("writes nothing when the governance snapshot is unchanged", async () => {
    const before = await db.execute<{ n: number }>(
      sql`select (select count(*) from person_roles where company_id = ${companyId})
        + (select count(*) from influence_extractions where company_id = ${companyId})
        + (select count(*) from influence_events where company_id = ${companyId}) as n`,
    );
    const r = await syncGovernance(ctx, companyId, {
      source: governanceSource(govFiling, () => ({ ...base, directors: board })),
    });
    expect(r).toMatchObject({ status: "unchanged", changed: false, rows: 0, edges: 0 });
    const after = await db.execute<{ n: number }>(
      sql`select (select count(*) from person_roles where company_id = ${companyId})
        + (select count(*) from influence_extractions where company_id = ${companyId})
        + (select count(*) from influence_events where company_id = ${companyId}) as n`,
    );
    expect(Number(after[0]?.n)).toBe(Number(before[0]?.n));
  });

  it("closes a dropped director and records board changes", async () => {
    board = [...directors.filter((d) => d.din !== independentDin), newcomer];
    const r = await syncGovernance(ctx, companyId, {
      source: governanceSource(govFiling, () => ({ ...base, directors: board })),
    });
    expect(r).toMatchObject({ status: "updated", events: 2 });

    const roles = await roleRows();
    expect(roles).toHaveLength(5);
    const dropped = roles.find((x) => x.din === independentDin);
    expect(dropped).toMatchObject({ status: "past", toDate: "2026-06-30" });

    const edges = await directorEdges();
    expect(edges.filter((e) => e.validTo === "2026-06-30")).toHaveLength(1);

    const feed = await events();
    expect(feed.map((e) => e.kind)).toEqual(["director_change", "director_change"]);
    expect(feed.map((e) => e.summary).join("|")).toMatch(/Newcomer .* joined the board/);
    expect(feed.map((e) => e.summary).join("|")).toMatch(/no longer listed on the board/);

    const extractions = await db
      .select({ status: influenceExtractions.status })
      .from(influenceExtractions)
      .where(eq(influenceExtractions.companyId, companyId));
    expect(extractions.map((x) => x.status)).toEqual(["succeeded", "succeeded"]);
  });

  it("stores related party rows, pending edges, material events and the perimeter", async () => {
    const parsed = parseRptXbrl(fixture("nse-rpt.xbrl.xml"));
    const report: RptReport = {
      ...parsed,
      rows: parsed.rows.map((row) =>
        rptRelationshipClass(row.relationship) === "kmp"
          ? row
          : { ...row, counterparty: `${row.counterparty} ${tag}` },
      ),
    };
    const source: RptSourceLike = {
      filings: async () => [rptFiling],
      report: async () => report,
    };
    const r = await syncRelatedParties(ctx, companyId, { source });
    expect(r.status).toBe("updated");
    expect(r.rows).toBe(12);
    expect(r.edges).toBeGreaterThan(0);
    expect(r.events).toBeGreaterThan(0);

    const rows = await db.execute<{ counterparty_name: string; value_cr: string; kind: string }>(
      sql`select r.counterparty_name, r.value_cr::text, c.kind from related_party_transactions r
          left join counterparties c on c.id = r.counterparty_id
          where r.company_id = ${companyId} and r.counterparty_name like ${`Tata Sons%`}
          order by r.value_cr desc`,
    );
    expect(rows[0]).toMatchObject({ value_cr: "100.00", kind: "private" });

    const edges = await db
      .select({
        id: influenceEdges.id,
        status: influenceEdges.status,
        version: influenceEdges.version,
      })
      .from(influenceEdges)
      .innerJoin(graphNodes, eq(graphNodes.id, influenceEdges.fromNodeId))
      .where(and(eq(influenceEdges.kind, "related_party"), eq(graphNodes.companyId, companyId)));
    expect(edges.length).toBeGreaterThan(0);
    expect(edges.every((e) => e.status === "pending")).toBe(true);

    const material = (await events()).filter((e) => e.kind === "material_rpt");
    expect(material.map((e) => e.summary).join("|")).toMatch(/Tata Sons.*100\.00 Cr/);

    const again = await syncRelatedParties(ctx, companyId, { source });
    expect(again.status).toBe("unchanged");

    const edge = edges[0] as (typeof edges)[number];
    await expect(
      db.execute(
        sql`select * from review_influence_edge(${edge.id}, 'confirm', 'test', null, ${edge.version + 1})`,
      ),
    ).rejects.toMatchObject({ cause: { code: "40001" } });
    const [review] = await db.execute<{ status: string; version: number }>(
      sql`select * from review_influence_edge(${edge.id}, 'confirm', 'test', 'checked', ${edge.version})`,
    );
    expect(review).toMatchObject({ status: "confirmed", version: edge.version + 1 });
    const visible = await db.execute<{ id: number }>(
      sql`select id from influence_edges_confirmed where id = ${edge.id}`,
    );
    expect(visible).toHaveLength(1);

    const perimeter = await syncPerimeter(ctx, companyId);
    expect(perimeter.promoters).toBeGreaterThanOrEqual(1);
    expect(perimeter.subsidiaries).toBeGreaterThanOrEqual(1);
    expect(perimeter.changed).toBe(true);
    const repeat = await syncPerimeter(ctx, companyId);
    expect(repeat.changed).toBe(false);
  });
});
