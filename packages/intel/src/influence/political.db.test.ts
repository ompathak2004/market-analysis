import { randomInt, randomUUID } from "node:crypto";
import { createLogger } from "@ma/core";
import {
  and,
  closeDb,
  companies,
  companyPolicySectors,
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
  policyEvents,
  politicalRoles,
  sql,
} from "@ma/db";
import type {
  Firecrawl,
  HttpClient,
  IngestContext,
  ParliamentMember,
  PolicyDocument,
} from "@ma/ingest";
import { DocumentStore, PARLIAMENT_PAGE_URL } from "@ma/ingest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  nseQuoteUrl,
  type PibSourceLike,
  seedCompanyPolicySectors,
  syncPib,
  tagPolicyEvent,
} from "./policy-sync.js";
import { type ParliamentSourceLike, syncParliament } from "./politics-sync.js";

const url = process.env.DATABASE_URL_TEST;

const letters = (s: string) =>
  s.replace(/[0-9]/g, (d) => "ghijklmnop"[Number(d)] ?? "x").replace(/[^a-z]/g, "");

describe.skipIf(!url)("political and policy sync (DATABASE_URL_TEST)", () => {
  let db: Db;
  let ctx: IngestContext;
  const raw = letters(randomUUID().slice(0, 8));
  const Tag = `${raw[0]?.toUpperCase() ?? "Q"}${raw.slice(1)}`;
  const symbol = `ZP${raw.toUpperCase()}`;
  const prid = `9${randomInt(10_000_000, 99_999_999)}`;
  const seed = { company: 0, meera: 0 };

  const member = (name: string, memberId: string): ParliamentMember => ({
    house: "lok_sabha",
    memberId,
    name: `${name} ${Tag}`,
    party: `Party ${Tag}`,
    partyCode: null,
    constituency: `Seat ${Tag}`,
    state: "Kerala",
    birthYear: null,
    fromDate: "2024-06-04",
    toDate: null,
  });
  const meera = member("Meera", `8${randomInt(10_000_000, 99_999_999)}`);
  const kabir = member("Kabir", `7${randomInt(10_000_000, 99_999_999)}`);
  const parliament = (members: ParliamentMember[]): ParliamentSourceLike => ({
    directory: async () => ({ members, ministers: [] }),
  });

  const release: PolicyDocument = {
    source: "pib",
    externalId: prid,
    title: `Cabinet approves storage support for Zephyr ${Tag} Power`,
    ministry: "Ministry of Power",
    stage: null,
    publishedAt: new Date("2026-10-01T10:00:00.000Z"),
    url: `https://pib.gov.in/PressReleasePage.aspx?PRID=${prid}`,
    text: "The Union Cabinet approved viability gap funding for battery energy storage systems.",
  };
  const pib: PibSourceLike = {
    recent: async () => [{ prid, title: release.title }],
    release: async () => release,
  };

  const personEdges = async (personId: number) =>
    db
      .select({
        id: influenceEdges.id,
        kind: influenceEdges.kind,
        status: influenceEdges.status,
        confidence: influenceEdges.confidence,
        validTo: influenceEdges.validTo,
        evidence: sql<number>`(select count(*)::int from influence_edge_evidence ee
                               where ee.edge_id = ${influenceEdges.id})`,
      })
      .from(influenceEdges)
      .innerJoin(graphNodes, eq(graphNodes.id, influenceEdges.fromNodeId))
      .where(eq(graphNodes.personId, personId))
      .orderBy(influenceEdges.kind);
  const personId = async (name: string) => {
    const [row] = await db
      .select({ id: persons.id })
      .from(persons)
      .where(eq(persons.canonicalName, `${name} ${Tag}`));
    return row?.id ?? 0;
  };
  const companyEvents = () =>
    db
      .select({ kind: influenceEvents.kind, summary: influenceEvents.summary })
      .from(influenceEvents)
      .where(eq(influenceEvents.companyId, seed.company))
      .orderBy(influenceEvents.id);

  beforeAll(async () => {
    db = createDb(url as string, 1);
    const logger = createLogger("test", "error");
    ctx = {
      db,
      docs: new DocumentStore(db, {} as HttpClient, {} as Firecrawl, logger, null),
      logger,
    } as unknown as IngestContext;
    const [company] = await db
      .insert(companies)
      .values({
        name: `Zephyr ${Tag} Power Limited`,
        normalizedName: `zephyr ${raw} power`,
        nseSymbol: symbol,
        industry: "Power",
      })
      .returning({ id: companies.id });
    seed.company = company?.id ?? 0;
    const [person] = await db
      .insert(persons)
      .values({
        din: String(randomInt(10_000_000, 99_999_999)),
        canonicalName: `Meera ${Tag}`,
        normalizedName: `meera ${raw}`,
      })
      .returning({ id: persons.id });
    seed.meera = person?.id ?? 0;
    await db.insert(personRoles).values({
      personId: seed.meera,
      companyId: seed.company,
      role: "director",
      status: "current",
      dedupeKey: `nse_governance:${seed.company}:${seed.meera}`,
    });
  });

  afterAll(async () => {
    if (!db) return;
    const kabirId = await personId("Kabir");
    await db.delete(companies).where(eq(companies.id, seed.company));
    await db.delete(persons).where(inArray(persons.id, [seed.meera, kabirId].filter(Boolean)));
    await db.delete(policyEvents).where(eq(policyEvents.externalId, prid));
    await db.delete(graphNodes).where(eq(graphNodes.partyName, `Party ${Tag}`));
    await db
      .delete(documents)
      .where(
        inArray(documents.url, [
          release.url,
          nseQuoteUrl(symbol),
          PARLIAMENT_PAGE_URL.lok_sabha,
          PARLIAMENT_PAGE_URL.rajya_sabha,
        ]),
      );
    await closeDb(db);
  });

  it("confirms member-id officeholders, holds name matches for review and is idempotent", async () => {
    const first = await syncParliament(ctx, { source: parliament([meera, kabir]) });
    expect(first.status).toBe("updated");
    expect(first.created).toBe(1);

    const kabirId = await personId("Kabir");
    expect(kabirId).toBeGreaterThan(0);
    expect(
      (await personEdges(kabirId)).map((e) => [e.kind, e.status, e.confidence, e.evidence]),
    ).toEqual([
      ["holds_office", "confirmed", 0.98, 1],
      ["member_of_party", "confirmed", 0.98, 1],
    ]);
    const meeraEdges = await personEdges(seed.meera);
    expect(meeraEdges.map((e) => [e.kind, e.status, e.confidence])).toEqual([
      ["holds_office", "pending", 0.8],
      ["member_of_party", "pending", 0.8],
    ]);
    expect(meeraEdges.every((e) => e.evidence === 1)).toBe(true);

    const edgeCount = async () =>
      (await personEdges(seed.meera)).length + (await personEdges(kabirId)).length;
    const extractions = async () =>
      (
        await db
          .select({ n: sql<number>`count(*)::int` })
          .from(influenceExtractions)
          .where(eq(influenceExtractions.family, "parliament"))
      )[0]?.n ?? 0;
    const before = { edges: await edgeCount(), extractions: await extractions() };
    const again = await syncParliament(ctx, { source: parliament([meera, kabir]) });
    expect(again).toMatchObject({ status: "unchanged", rows: 0, edges: 0, events: 0 });
    expect({ edges: await edgeCount(), extractions: await extractions() }).toEqual(before);
    expect(await companyEvents()).toEqual([]);
  });

  it("closes a dropped seat and reports it on the director's company", async () => {
    const res = await syncParliament(ctx, { source: parliament([kabir]) });
    expect(res.status).toBe("updated");
    const [role] = await db
      .select({ status: politicalRoles.status, toDate: politicalRoles.toDate })
      .from(politicalRoles)
      .where(eq(politicalRoles.personId, seed.meera));
    expect(role?.status).toBe("past");
    const office = (await personEdges(seed.meera)).find((e) => e.kind === "holds_office");
    expect(office?.validTo).toBe(role?.toDate);
    expect(await companyEvents()).toEqual([
      { kind: "office_lost", summary: `Meera ${Tag} no longer listed in the Lok Sabha` },
    ]);
  });

  it("stores policy releases once and maps the company to its NSE industry sector with evidence", async () => {
    const first = await syncPib(ctx, { source: pib });
    expect(first).toMatchObject({ listed: 1, fetched: 1, created: 1, failed: 0 });
    expect(await syncPib(ctx, { source: pib })).toMatchObject({ listed: 1, fetched: 0 });

    const seeded = await seedCompanyPolicySectors(ctx);
    expect(seeded.rows).toBeGreaterThanOrEqual(1);
    const sectors = await db
      .select({ key: companyPolicySectors.sectorKey, span: companyPolicySectors.evidenceSpanId })
      .from(companyPolicySectors)
      .where(eq(companyPolicySectors.companyId, seed.company));
    expect(sectors.map((s) => s.key)).toEqual(["power"]);
    expect(sectors[0]?.span).not.toBeNull();
    const sectorEdge = await db
      .select({ status: influenceEdges.status, id: influenceEdges.id })
      .from(influenceEdges)
      .innerJoin(graphNodes, eq(graphNodes.id, influenceEdges.fromNodeId))
      .where(
        and(eq(graphNodes.companyId, seed.company), eq(influenceEdges.kind, "operates_in_sector")),
      );
    expect(sectorEdge.map((e) => e.status)).toEqual(["confirmed"]);
    const [cited] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(influenceEdgeEvidence)
      .where(eq(influenceEdgeEvidence.edgeId, sectorEdge[0]?.id ?? 0));
    expect(cited?.n).toBe(1);

    const rerun = await seedCompanyPolicySectors(ctx);
    expect(rerun).toMatchObject({ rows: 0, edges: 0 });
  });

  it("tags by ministry rule and company name without the LLM, once", async () => {
    const [ev] = await db
      .select({ id: policyEvents.id })
      .from(policyEvents)
      .where(and(eq(policyEvents.source, "pib"), eq(policyEvents.externalId, prid)));
    const id = ev?.id ?? 0;
    const res = await tagPolicyEvent(ctx, id);
    expect(res).toMatchObject({ status: "tagged", llmTags: 0, tokens: 0 });

    const tags = await db.execute<{
      target: string;
      status: string;
      confidence: number;
      evidence: number;
    }>(sql`
      select coalesce(t.sector_key, 'company') as target, e.status::text as status,
             e.confidence, (select count(*)::int from influence_edge_evidence ee
                            where ee.edge_id = e.id) as evidence
      from policy_event_tags t
      join influence_edges e on e.policy_event_tag_id = t.id
      where t.policy_event_id = ${id}
        and (t.company_id is null or t.company_id = ${seed.company})
      order by target`);
    expect([...tags]).toEqual([
      { target: "company", status: "pending", confidence: 0.8, evidence: 1 },
      { target: "power", status: "confirmed", confidence: 0.95, evidence: 1 },
    ]);
    const policy = (await companyEvents()).filter((e) => e.kind === "policy_change");
    expect(policy).toEqual([{ kind: "policy_change", summary: `PIB: ${release.title}` }]);
    const [coverage] = await db
      .select({ at: influenceCoverage.policyReadAt })
      .from(influenceCoverage)
      .where(eq(influenceCoverage.companyId, seed.company));
    expect(coverage?.at).toBeInstanceOf(Date);

    expect(await tagPolicyEvent(ctx, id)).toMatchObject({ status: "unchanged", edges: 0 });
    expect((await companyEvents()).filter((e) => e.kind === "policy_change")).toHaveLength(1);
  });
});
