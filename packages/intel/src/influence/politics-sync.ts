import { assertTimeLeft, chunk, isoDate, sha256, throwIfAborted } from "@ma/core";
import {
  affidavitInterests,
  and,
  counterparties,
  electoralBondRows,
  eq,
  graphNodes,
  inArray,
  influenceEdges,
  isNull,
  personIdentifiers,
  personRoles,
  persons,
  politicalDonations,
  politicalRoles,
  sql,
  type Tx,
} from "@ma/db";
import {
  type BondRow,
  bondKey,
  businessKey,
  ECI_BONDS_PARSER_VERSION,
  EciBondsSource,
  holdingKey,
  type IngestContext,
  MYNETA_PARSER_VERSION,
  type MynetaCandidate,
  type MynetaElection,
  type MynetaListing,
  MynetaSource,
  matchBonds,
  memberKey,
  mynetaCandidateKey,
  mynetaSnapshot,
  normalizeCompanyName,
  PARLIAMENT_PAGE_URL,
  PARLIAMENT_PARSER_VERSION,
  type ParliamentDirectory,
  type ParliamentHouse,
  ParliamentSource,
  type ParsedPdf,
  parliamentSnapshot,
  parseBondRows,
  parseMynetaCandidateKey,
} from "@ma/ingest";
import { type OfficeState, officeChanges } from "./events.js";
import { normalizePersonName, PERSON_NORMALIZER_VERSION } from "./normalize.js";
import {
  holdingKind,
  INSTITUTION,
  matchMynetaListing,
  mynetaElectionFor,
  type OfficeClaim,
  officeClaims,
  POLITICS_RULE_VERSION,
  type PoliticalOffice,
  rupeesToCrore,
} from "./politics.js";
import { CONFIDENCE, confidenceFor, INFLUENCE_RESOLVER_VERSION, resolvePerson } from "./resolve.js";
import { INFLUENCE_EVENT_RULE_VERSION } from "./rules.js";
import {
  addAlias,
  allPersonCandidates,
  alreadyExtracted,
  type Extraction,
  type InfluenceSyncResult,
  listedCompanyIndex,
  nodeFor,
  nodeOf,
  recordEvent,
  result,
  runExtraction,
  spanFor,
  touchCoverage,
  upsertEdge,
} from "./store.js";
import type { PersonCandidate } from "./types.js";

const PARLIAMENT_BATCH_SIZE = 25;
const PARLIAMENT_SOURCE = "parliament";
const MYNETA_SOURCE = "myneta";
const BONDS_SOURCE = "eci_bonds";
const HOUSES: readonly ParliamentHouse[] = ["lok_sabha", "rajya_sabha"];
const HOUSE_CODE: Readonly<Record<ParliamentHouse, string>> = {
  lok_sabha: "ls",
  rajya_sabha: "rs",
};
const MP_OFFICES = ["mp_lok_sabha", "mp_rajya_sabha"] as const;
const BOND_INSERT_CHUNK = 500;
const BOND_EVIDENCE_PER_EDGE = 3;

export interface ParliamentSourceLike {
  directory(signal?: AbortSignal): Promise<ParliamentDirectory>;
}

export interface MynetaSourceLike {
  listing(election: MynetaElection, signal?: AbortSignal): Promise<MynetaListing[]>;
  candidate(
    election: MynetaElection,
    candidateId: string,
    signal?: AbortSignal,
  ): Promise<MynetaCandidate>;
}

export interface BondsSourceLike {
  document(url: string, signal?: AbortSignal): Promise<ParsedPdf>;
}

export interface ParliamentSyncResult extends InfluenceSyncResult {
  created: number;
}

export interface AffidavitTarget {
  personId: number;
  candidate: string;
}

export interface BondInput {
  purchaseUrls: readonly string[];
  redemptionUrls: readonly string[];
}

export interface BondSyncResult extends InfluenceSyncResult {
  purchases: number;
  redemptions: number;
  donations: number;
  ambiguous: number;
}

interface Resolved {
  personId: number;
  confidence: number;
  identifier: boolean;
}

const houseOfKey = (key: string): ParliamentHouse | null => {
  const code = /^parliament:(?:minister:)?(ls|rs):/.exec(key)?.[1];
  return code === "ls" ? "lok_sabha" : code === "rs" ? "rajya_sabha" : null;
};

const institutionOf = (office: string): string =>
  office in INSTITUTION ? INSTITUTION[office as PoliticalOffice] : office;

async function resolveMember(
  tx: Tx,
  claim: OfficeClaim,
  candidates: PersonCandidate[],
  revisionId: number,
): Promise<(Resolved & { created: boolean }) | null> {
  const { member, identifier } = claim;
  const byId = resolvePerson(
    { name: member.name, memberId: identifier, source: "structured_primary" },
    candidates,
  );
  if (byId.personId !== null) {
    return {
      personId: byId.personId,
      confidence: byId.confidence,
      identifier: true,
      created: false,
    };
  }
  const unbound = candidates.filter(
    (c) => !(c.identifiers ?? []).some((i) => i.scheme === identifier.scheme),
  );
  const byName = resolvePerson({ name: member.name, source: "primary" }, unbound);
  if (byName.basis === "ambiguous") return null;
  if (byName.personId !== null) {
    return {
      personId: byName.personId,
      confidence: byName.confidence,
      identifier: false,
      created: false,
    };
  }
  const normalizedName = normalizePersonName(member.name);
  const [row] = await tx
    .insert(persons)
    .values({ canonicalName: member.name, normalizedName, birthYear: member.birthYear })
    .returning({ id: persons.id });
  if (!row) throw new Error(`person insert failed for ${member.name}`);
  await tx
    .insert(personIdentifiers)
    .values({ ...identifier, personId: row.id, documentRevisionId: revisionId })
    .onConflictDoNothing();
  candidates.push({
    id: row.id,
    din: null,
    normalizedName,
    aliases: [],
    identifiers: [identifier],
  });
  return {
    personId: row.id,
    confidence: confidenceFor("member_id", "structured_primary"),
    identifier: true,
    created: true,
  };
}

async function boardCompanies(tx: Tx, personId: number): Promise<number[]> {
  const rows = await tx
    .selectDistinct({ companyId: personRoles.companyId })
    .from(personRoles)
    .where(and(eq(personRoles.personId, personId), eq(personRoles.status, "current")));
  return rows.flatMap((r) => (r.companyId === null ? [] : [r.companyId]));
}

export async function syncParliament(
  ctx: IngestContext,
  opts: { signal?: AbortSignal; source?: ParliamentSourceLike } = {},
): Promise<ParliamentSyncResult> {
  const { signal } = opts;
  const source = opts.source ?? new ParliamentSource(ctx.http);
  const dir = await source.directory(signal);
  throwIfAborted(signal);
  const claims = officeClaims(dir);
  const total: ParliamentSyncResult = { ...result("unchanged"), created: 0 };
  for (const house of HOUSES) {
    const out = await syncHouse(ctx, dir, house, claims, signal);
    if (!out) continue;
    total.status = "updated";
    total.changed = true;
    total.rows += out.rows;
    total.edges += out.edges;
    total.events += out.events;
    total.skipped += out.skipped;
    total.created += out.created;
  }
  return total;
}

async function syncHouse(
  ctx: IngestContext,
  dir: ParliamentDirectory,
  house: ParliamentHouse,
  allClaims: readonly OfficeClaim[],
  signal: AbortSignal | undefined,
) {
  const snap = parliamentSnapshot(dir, house);
  const { revision } = await ctx.docs.putInline(PARLIAMENT_PAGE_URL[house], snap.content, {
    source: PARLIAMENT_SOURCE,
    contentType: "application/json",
    ...(signal ? { signal } : {}),
  });
  const extraction: Extraction = {
    documentRevisionId: revision.id,
    companyId: null,
    family: "parliament",
    version: PARLIAMENT_PARSER_VERSION,
    inputHash: sha256(
      [
        revision.contentSha256,
        PARLIAMENT_PARSER_VERSION,
        POLITICS_RULE_VERSION,
        PERSON_NORMALIZER_VERSION,
        INFLUENCE_RESOLVER_VERSION,
        INFLUENCE_EVENT_RULE_VERSION,
      ].join(":"),
    ),
  };
  if (await alreadyExtracted(ctx, extraction)) return null;
  const claims = allClaims.filter((c) => c.member.house === house);
  const today = isoDate(new Date());

  const previous = (
    await ctx.db
      .select({
        id: politicalRoles.id,
        personId: politicalRoles.personId,
        dedupeKey: politicalRoles.dedupeKey,
        status: politicalRoles.status,
        office: politicalRoles.office,
        name: persons.canonicalName,
      })
      .from(politicalRoles)
      .innerJoin(persons, eq(persons.id, politicalRoles.personId))
      .where(eq(politicalRoles.source, PARLIAMENT_SOURCE))
  ).filter((p) => houseOfKey(p.dedupeKey) === house);
  const firstRead = previous.length === 0;

  const candidates = await ctx.db.transaction((tx) => allPersonCandidates(tx));
  const totals = { edges: 0, skipped: 0, created: 0 };
  for (const [index, batch] of chunk(claims, PARLIAMENT_BATCH_SIZE).entries()) {
    throwIfAborted(signal);
    assertTimeLeft(30_000);
    const batchExtraction = {
      ...extraction,
      inputHash: sha256(`${extraction.inputHash}:batch:${index}`),
    };
    if (await alreadyExtracted(ctx, batchExtraction)) continue;
    const out = await runExtraction(ctx, batchExtraction, signal, async (tx) => {
      const resolved = new Map<string, Resolved>();
      const seen = new Set<string>();
      let edges = 0;
      let skipped = 0;
      let created = 0;
      for (const claim of batch) {
        throwIfAborted(signal);
        const { member } = claim;
        const mk = memberKey(member);
        let who = resolved.get(mk) ?? null;
        if (!who) {
          const r = await resolveMember(tx, claim, candidates, revision.id);
          if (!r) {
            skipped += 1;
            continue;
          }
          if (r.created) created += 1;
          who = r;
          resolved.set(mk, r);
          await addAlias(tx, r.personId, member.name, PARLIAMENT_SOURCE);
        }
        if (seen.has(claim.key)) continue;
        seen.add(claim.key);
        const spanId = await spanFor(tx, revision.id, snap.content, snap.spans.get(claim.spanKey), {
          kind: claim.office,
          house: HOUSE_CODE[house],
          memberId: member.memberId,
        });
        const fields = {
          personId: who.personId,
          office: claim.office,
          party: member.party,
          constituency: member.constituency,
          state: member.state,
          fromDate: claim.fromDate,
          toDate: claim.toDate,
          source: PARLIAMENT_SOURCE,
          documentRevisionId: revision.id,
          status: "current" as const,
        };
        const [role] = await tx
          .insert(politicalRoles)
          .values({ ...fields, dedupeKey: claim.key })
          .onConflictDoUpdate({
            target: politicalRoles.dedupeKey,
            set: { ...fields, updatedAt: new Date() },
          })
          .returning({ id: politicalRoles.id });
        if (!role) throw new Error(`political role upsert failed for ${claim.key}`);
        const personNode = await nodeFor(tx, "person", who.personId);
        const office = await upsertEdge(tx, {
          fromNodeId: personNode,
          toNodeId: await nodeOf(tx, { kind: "party", partyName: INSTITUTION[claim.office] }),
          kind: "holds_office",
          fact: { politicalRoleId: role.id },
          confidence: who.confidence,
          source: "structured_primary",
          identifier: who.identifier,
          inputHash: sha256(
            JSON.stringify([
              claim.key,
              claim.label,
              member.constituency,
              member.state,
              claim.fromDate,
              claim.toDate,
            ]),
          ),
          validFrom: claim.fromDate,
          validTo: claim.toDate,
          spanIds: spanId ? [spanId] : [],
        });
        if (office?.changed) edges += 1;
        if (claim.office !== "minister" && member.party) {
          const party = await upsertEdge(tx, {
            fromNodeId: personNode,
            toNodeId: await nodeOf(tx, { kind: "party", partyName: member.party }),
            kind: "member_of_party",
            fact: {},
            confidence: who.confidence,
            source: "structured_primary",
            identifier: who.identifier,
            inputHash: sha256(JSON.stringify([mk, member.party])),
            validFrom: null,
            validTo: null,
            spanIds: spanId ? [spanId] : [],
          });
          if (party?.changed) edges += 1;
        }
      }

      return { rows: seen.size, edges, skipped, created };
    });
    totals.edges += out.edges;
    totals.skipped += out.skipped;
    totals.created += out.created;
  }
  return runExtraction(ctx, extraction, signal, async (tx) => {
    throwIfAborted(signal);
    const seen = new Set(claims.map((c) => c.key));
    const roles = await tx
      .select({
        key: politicalRoles.dedupeKey,
        personId: politicalRoles.personId,
        office: politicalRoles.office,
        status: politicalRoles.status,
        name: persons.canonicalName,
        edgeId: influenceEdges.id,
      })
      .from(politicalRoles)
      .innerJoin(persons, eq(persons.id, politicalRoles.personId))
      .leftJoin(
        influenceEdges,
        and(
          eq(influenceEdges.politicalRoleId, politicalRoles.id),
          eq(influenceEdges.kind, "holds_office"),
          inArray(influenceEdges.status, ["pending", "confirmed"]),
        ),
      )
      .where(eq(politicalRoles.source, PARLIAMENT_SOURCE));
    const current = roles
      .filter((r) => seen.has(r.key))
      .map((r) => ({
        ...r,
        label: institutionOf(r.office),
      }));
    let edges = totals.edges;

    const gone = previous.filter((p) => p.status === "current" && !seen.has(p.dedupeKey));
    const closedByRole = new Map<number, number[]>();
    if (gone.length) {
      const ids = gone.map((p) => p.id);
      await tx
        .update(politicalRoles)
        .set({ status: "past", toDate: today, updatedAt: new Date() })
        .where(inArray(politicalRoles.id, ids));
      const closed = await tx
        .update(influenceEdges)
        .set({ validTo: today, updatedAt: new Date() })
        .where(
          and(
            inArray(influenceEdges.politicalRoleId, ids),
            isNull(influenceEdges.validTo),
            sql`(${influenceEdges.validFrom} is null or ${influenceEdges.validFrom} <= ${today})`,
          ),
        )
        .returning({ id: influenceEdges.id, roleId: influenceEdges.politicalRoleId });
      edges += closed.length;
      for (const c of closed) {
        if (c.roleId === null) continue;
        closedByRole.set(c.roleId, [...(closedByRole.get(c.roleId) ?? []), c.id]);
      }
    }

    let events = 0;
    if (!firstRead) {
      const before: OfficeState[] = previous.map((p) => ({
        key: p.dedupeKey,
        personId: p.personId,
        label: institutionOf(p.office),
        status: p.status,
      }));
      const changes = officeChanges(before, current);
      const at = new Date();
      for (const g of changes.gained) {
        const hit = current.find((c) => c.key === g.key);
        for (const companyId of await boardCompanies(tx, g.personId)) {
          const recorded = await recordEvent(
            tx,
            companyId,
            "office_gained",
            at,
            `${hit?.name ?? "A director"} took public office: ${g.label}`,
            [g.personId, g.key, "gained", revision.id],
            hit?.edgeId ? [hit.edgeId] : [],
          );
          if (recorded) events += 1;
        }
      }
      for (const l of changes.lost) {
        const prev = previous.find((p) => p.dedupeKey === l.key);
        for (const companyId of await boardCompanies(tx, l.personId)) {
          const recorded = await recordEvent(
            tx,
            companyId,
            "office_lost",
            at,
            `${prev?.name ?? "A director"} no longer listed in the ${l.label}`,
            [l.personId, l.key, "lost", revision.id],
            prev ? (closedByRole.get(prev.id) ?? []) : [],
          );
          if (recorded) events += 1;
        }
      }
    }

    return { rows: seen.size, edges, events, skipped: totals.skipped, created: totals.created };
  });
}

export async function affidavitTargets(
  ctx: IngestContext,
  opts: { signal?: AbortSignal; source?: MynetaSourceLike; limit?: number } = {},
): Promise<AffidavitTarget[]> {
  const { signal } = opts;
  const people = await ctx.db
    .select({
      personId: politicalRoles.personId,
      office: politicalRoles.office,
      constituency: politicalRoles.constituency,
      state: politicalRoles.state,
      name: persons.canonicalName,
    })
    .from(politicalRoles)
    .innerJoin(persons, eq(persons.id, politicalRoles.personId))
    .where(
      and(
        eq(politicalRoles.source, PARLIAMENT_SOURCE),
        eq(politicalRoles.status, "current"),
        inArray(politicalRoles.office, [...MP_OFFICES]),
        sql`not exists (select 1 from ${personIdentifiers} pi
          where pi.person_id = ${politicalRoles.personId} and pi.scheme = 'myneta_candidate')`,
      ),
    )
    .orderBy(politicalRoles.personId);
  if (!people.length) return [];
  const source = opts.source ?? new MynetaSource(ctx.http);
  const houses = new Set<ParliamentHouse>(
    people.map((p) => (p.office === "mp_lok_sabha" ? "lok_sabha" : "rajya_sabha")),
  );
  const listings: MynetaListing[] = [];
  for (const house of houses) {
    listings.push(...(await source.listing(mynetaElectionFor(house), signal)));
  }
  const out: AffidavitTarget[] = [];
  const taken = new Set<number>();
  for (const p of people) {
    if (taken.has(p.personId)) continue;
    const hit = matchMynetaListing(
      {
        house: p.office === "mp_lok_sabha" ? "lok_sabha" : "rajya_sabha",
        name: p.name,
        constituency: p.constituency,
        state: p.state,
      },
      listings,
    );
    if (!hit) continue;
    taken.add(p.personId);
    out.push({
      personId: p.personId,
      candidate: mynetaCandidateKey(hit.election, hit.candidateId),
    });
    if (opts.limit && out.length >= opts.limit) break;
  }
  return out;
}

async function refreshAffidavitCoverage(tx: Tx, companyIds: readonly number[]) {
  for (const companyId of companyIds) {
    const [row] = await tx
      .select({ n: sql<number>`count(distinct ${affidavitInterests.personId})::int` })
      .from(affidavitInterests)
      .innerJoin(graphNodes, eq(graphNodes.id, affidavitInterests.targetNodeId))
      .where(eq(graphNodes.companyId, companyId));
    await touchCoverage(tx, companyId, { affidavitsRead: row?.n ?? 0 });
  }
}

export async function syncAffidavit(
  ctx: IngestContext,
  target: AffidavitTarget,
  opts: { signal?: AbortSignal; source?: MynetaSourceLike } = {},
): Promise<InfluenceSyncResult> {
  const { signal } = opts;
  const parsed = parseMynetaCandidateKey(target.candidate);
  if (!parsed) throw new Error(`invalid MyNeta candidate key ${target.candidate}`);
  const source = opts.source ?? new MynetaSource(ctx.http);
  const c = await source.candidate(parsed.election, parsed.candidateId, signal);
  throwIfAborted(signal);
  const snap = mynetaSnapshot(c);
  const { revision } = await ctx.docs.putInline(c.url, snap.content, {
    source: MYNETA_SOURCE,
    contentType: "application/json",
    ...(signal ? { signal } : {}),
  });
  const extraction: Extraction = {
    documentRevisionId: revision.id,
    companyId: null,
    family: "myneta",
    version: MYNETA_PARSER_VERSION,
    inputHash: sha256(
      [
        revision.contentSha256,
        MYNETA_PARSER_VERSION,
        POLITICS_RULE_VERSION,
        INFLUENCE_RESOLVER_VERSION,
        target.personId,
      ].join(":"),
    ),
  };
  if (await alreadyExtracted(ctx, extraction)) return result("unchanged");
  const listed = await listedCompanyIndex(ctx);

  const out = await runExtraction(ctx, extraction, signal, async (tx) => {
    await tx
      .insert(personIdentifiers)
      .values({
        scheme: "myneta_candidate",
        value: target.candidate,
        personId: target.personId,
        documentRevisionId: revision.id,
      })
      .onConflictDoNothing();
    const personNode = await nodeFor(tx, "person", target.personId);
    const touched = new Set<number>();
    let edges = 0;
    let rows = 0;
    for (const h of c.holdings) {
      const key = holdingKey(h);
      const companyId = listed.get(normalizeCompanyName(h.company)) ?? null;
      const companyNode = companyId === null ? null : await nodeFor(tx, "company", companyId);
      const spanId = await spanFor(tx, revision.id, snap.content, snap.spans.get(key), {
        kind: "holding",
        holder: h.holder,
        candidate: target.candidate,
      });
      const fields = {
        personId: target.personId,
        kind: holdingKind(h),
        targetNodeId: companyNode,
        description: h.description,
        valueCr: rupeesToCrore(h.valueRs),
        documentRevisionId: revision.id,
        evidenceSpanId: spanId,
      };
      const [interest] = await tx
        .insert(affidavitInterests)
        .values({ ...fields, dedupeKey: `${MYNETA_SOURCE}:${target.candidate}:${key}` })
        .onConflictDoUpdate({ target: affidavitInterests.dedupeKey, set: fields })
        .returning({ id: affidavitInterests.id });
      if (!interest) throw new Error(`affidavit interest upsert failed for ${key}`);
      rows += 1;
      if (companyId === null || companyNode === null) continue;
      touched.add(companyId);
      const edge = await upsertEdge(tx, {
        fromNodeId: personNode,
        toNodeId: companyNode,
        kind: h.holder === "self" ? "declared_interest" : "declared_family",
        fact: { affidavitInterestId: interest.id },
        confidence: CONFIDENCE.singleDocumentName,
        source: "primary",
        identifier: false,
        inputHash: sha256(JSON.stringify([key, h.shares, h.valueRs, companyId])),
        validFrom: null,
        validTo: null,
        spanIds: spanId ? [spanId] : [],
      });
      if (edge?.changed) edges += 1;
    }
    for (const b of c.businesses) {
      const key = businessKey(b);
      const spanId = await spanFor(tx, revision.id, snap.content, snap.spans.get(key), {
        kind: "business",
        holder: b.holder,
        candidate: target.candidate,
      });
      const fields = {
        personId: target.personId,
        kind: "business_interest" as const,
        description: b.description,
        documentRevisionId: revision.id,
        evidenceSpanId: spanId,
      };
      await tx
        .insert(affidavitInterests)
        .values({ ...fields, dedupeKey: `${MYNETA_SOURCE}:${target.candidate}:${key}` })
        .onConflictDoUpdate({ target: affidavitInterests.dedupeKey, set: fields });
      rows += 1;
    }
    await refreshAffidavitCoverage(tx, [...touched]);
    return { rows, edges, events: 0, skipped: 0 };
  });
  return result("updated", { changed: true, ...out });
}

async function bondCounterparty(
  tx: Tx,
  name: string,
  listed: ReadonlyMap<string, number>,
  cache: Map<string, { counterpartyId: number | null; companyId: number | null }>,
) {
  const normalized = normalizeCompanyName(name);
  const cached = cache.get(normalized);
  if (cached) return cached;
  const companyId = normalized ? (listed.get(normalized) ?? null) : null;
  const [hit] = normalized
    ? await tx
        .select({ id: counterparties.id, companyId: counterparties.companyId })
        .from(counterparties)
        .where(
          companyId === null
            ? eq(counterparties.normalizedName, normalized)
            : sql`${counterparties.normalizedName} = ${normalized} or ${counterparties.companyId} = ${companyId}`,
        )
        .limit(1)
    : [];
  let counterpartyId = hit?.id ?? null;
  if (counterpartyId === null && companyId !== null) {
    const [created] = await tx
      .insert(counterparties)
      .values({ kind: "listed", canonicalName: name.trim(), normalizedName: normalized, companyId })
      .onConflictDoNothing()
      .returning({ id: counterparties.id });
    counterpartyId = created?.id ?? null;
  }
  const out = { counterpartyId, companyId: companyId ?? hit?.companyId ?? null };
  cache.set(normalized, out);
  return out;
}

async function insertBondRows(
  tx: Tx,
  rows: readonly (BondRow & { revisionId: number; counterpartyId: number | null })[],
): Promise<Map<string, number>> {
  const ids = new Map<string, number>();
  for (let i = 0; i < rows.length; i += BOND_INSERT_CHUNK) {
    const chunk = rows.slice(i, i + BOND_INSERT_CHUNK);
    const inserted = await tx
      .insert(electoralBondRows)
      .values(
        chunk.map((r) => ({
          kind: r.kind,
          bondPrefix: r.prefix,
          bondNumber: r.number,
          denomination: r.denomination,
          date: r.date,
          partyOrPurchaser: r.name,
          counterpartyId: r.counterpartyId,
          documentRevisionId: r.revisionId,
          page: r.page,
        })),
      )
      .onConflictDoUpdate({
        target: [
          electoralBondRows.kind,
          electoralBondRows.bondPrefix,
          electoralBondRows.bondNumber,
          electoralBondRows.denomination,
        ],
        set: {
          date: sql`excluded.date`,
          partyOrPurchaser: sql`excluded.party_or_purchaser`,
          counterpartyId: sql`excluded.counterparty_id`,
          documentRevisionId: sql`excluded.document_revision_id`,
          page: sql`excluded.page`,
        },
      })
      .returning({
        id: electoralBondRows.id,
        kind: electoralBondRows.kind,
        prefix: electoralBondRows.bondPrefix,
        number: electoralBondRows.bondNumber,
        denomination: electoralBondRows.denomination,
      });
    for (const r of inserted) ids.set(`${r.kind}:${bondKey(r)}`, r.id);
  }
  return ids;
}

interface BondDoc {
  url: string;
  kind: BondRow["kind"];
  pdf: ParsedPdf;
  revisionId: number;
  sha: string;
}

export async function syncBonds(
  ctx: IngestContext,
  input: BondInput,
  opts: { signal?: AbortSignal; source?: BondsSourceLike } = {},
): Promise<BondSyncResult> {
  const { signal } = opts;
  const source = opts.source ?? new EciBondsSource(ctx.http);
  const docs: BondDoc[] = [];
  const inputs = [
    ...input.purchaseUrls.map((url) => ({ url, kind: "purchase" as const })),
    ...input.redemptionUrls.map((url) => ({ url, kind: "redemption" as const })),
  ];
  for (const { url, kind } of inputs) {
    const pdf = await source.document(url, signal);
    throwIfAborted(signal);
    const { revision } = await ctx.docs.putInline(url, pdf.text, {
      source: BONDS_SOURCE,
      contentType: "text/plain; charset=utf-8",
      ...(signal ? { signal } : {}),
    });
    docs.push({ url, kind, pdf, revisionId: revision.id, sha: revision.contentSha256 });
  }
  const empty: BondSyncResult = {
    ...result("no_filing"),
    purchases: 0,
    redemptions: 0,
    donations: 0,
    ambiguous: 0,
  };
  const [first] = docs;
  if (!first) return empty;
  const extraction: Extraction = {
    documentRevisionId: first.revisionId,
    companyId: null,
    family: "eci_bonds",
    version: ECI_BONDS_PARSER_VERSION,
    inputHash: sha256(
      [
        ...docs.map((d) => `${d.kind}:${d.sha}`).sort(),
        ECI_BONDS_PARSER_VERSION,
        INFLUENCE_RESOLVER_VERSION,
        INFLUENCE_EVENT_RULE_VERSION,
      ].join(":"),
    ),
  };
  if (await alreadyExtracted(ctx, extraction)) return { ...empty, status: "unchanged" };
  const listed = await listedCompanyIndex(ctx);

  const out = await runExtraction(ctx, extraction, signal, async (tx) => {
    const cache = new Map<string, { counterpartyId: number | null; companyId: number | null }>();
    for (const cp of await tx
      .select({
        id: counterparties.id,
        name: counterparties.normalizedName,
        companyId: counterparties.companyId,
      })
      .from(counterparties)) {
      cache.set(cp.name, { counterpartyId: cp.id, companyId: cp.companyId });
    }
    const parsed = docs.flatMap((d) => parseBondRows(d.pdf, d.kind).map((r) => ({ ...r, doc: d })));
    const rows: (BondRow & {
      revisionId: number;
      counterpartyId: number | null;
      companyId: number | null;
      doc: BondDoc;
    })[] = [];
    for (const r of parsed) {
      throwIfAborted(signal);
      const cp =
        r.kind === "purchase"
          ? await bondCounterparty(tx, r.name, listed, cache)
          : { counterpartyId: null, companyId: null };
      rows.push({ ...r, revisionId: r.doc.revisionId, ...cp });
    }
    const ids = await insertBondRows(tx, rows);
    const purchases = rows.filter((r) => r.kind === "purchase");
    const redemptions = rows.filter((r) => r.kind === "redemption");
    const match = matchBonds(purchases, redemptions);
    const donationIds = new Map<number, number>();
    const matched = match.pairs.flatMap(({ purchase: p, redemption: r }) => {
      const purchaseRowId = ids.get(`purchase:${bondKey(p)}`);
      const redemptionRowId = ids.get(`redemption:${bondKey(r)}`);
      return purchaseRowId === undefined || redemptionRowId === undefined
        ? []
        : [
            {
              purchaseRowId,
              redemptionRowId,
              counterpartyId: p.counterpartyId,
              party: r.name,
              amount: p.denomination,
              matchedOn: bondKey(p),
            },
          ];
    });
    for (const batch of chunk(matched, BOND_INSERT_CHUNK)) {
      throwIfAborted(signal);
      const inserted = await tx
        .insert(politicalDonations)
        .values(batch)
        .onConflictDoUpdate({
          target: politicalDonations.purchaseRowId,
          set: {
            counterpartyId: sql`excluded.counterparty_id`,
            party: sql`excluded.party`,
            amount: sql`excluded.amount`,
          },
        })
        .returning({ id: politicalDonations.id, purchaseRowId: politicalDonations.purchaseRowId });
      for (const row of inserted) donationIds.set(row.purchaseRowId, row.id);
    }
    const byPair = new Map<
      string,
      {
        from: { counterpartyId: number; companyId: number | null; name: string };
        party: string;
        donations: { id: number; amount: number; date: string; spans: number[] }[];
      }
    >();
    let donations = 0;
    for (const pair of match.pairs) {
      throwIfAborted(signal);
      const p = pair.purchase;
      const r = pair.redemption;
      const purchaseRowId = ids.get(`purchase:${bondKey(p)}`);
      const redemptionRowId = ids.get(`redemption:${bondKey(r)}`);
      if (purchaseRowId === undefined || redemptionRowId === undefined) continue;
      const donationId = donationIds.get(purchaseRowId);
      if (donationId === undefined) continue;
      donations += 1;
      if (p.counterpartyId === null) continue;
      const key = `${p.counterpartyId}|${r.name}`;
      const entry = byPair.get(key) ?? {
        from: { counterpartyId: p.counterpartyId, companyId: p.companyId, name: p.name },
        party: r.name,
        donations: [],
      };
      const spans: number[] = [];
      if (entry.donations.length < BOND_EVIDENCE_PER_EDGE) {
        for (const row of [p, r]) {
          const spanId = await spanFor(
            tx,
            row.revisionId,
            row.doc.pdf.text,
            { start: row.start, end: row.end },
            { kind: row.kind, page: row.page, bond: bondKey(row) },
          );
          if (spanId) spans.push(spanId);
        }
      }
      entry.donations.push({ id: donationId, amount: p.denomination, date: r.date, spans });
      byPair.set(key, entry);
    }

    let edges = 0;
    let events = 0;
    for (const entry of byPair.values()) {
      const fromNode =
        entry.from.companyId !== null
          ? await nodeFor(tx, "company", entry.from.companyId)
          : await nodeFor(tx, "counterparty", entry.from.counterpartyId);
      const sorted = [...entry.donations].sort((a, b) => a.date.localeCompare(b.date));
      const totalRs = sorted.reduce((s, d) => s + d.amount, 0);
      const firstDate = sorted[0]?.date ?? null;
      const lastDate = sorted[sorted.length - 1]?.date ?? null;
      const edge = await upsertEdge(tx, {
        fromNodeId: fromNode,
        toNodeId: await nodeOf(tx, { kind: "party", partyName: entry.party }),
        kind: "donated_to",
        fact: sorted[0] ? { donationId: sorted[0].id } : {},
        confidence: CONFIDENCE.singleDocumentName,
        source: "primary",
        identifier: false,
        inputHash: sha256(JSON.stringify([entry.from.name, entry.party, totalRs, sorted.length])),
        validFrom: firstDate,
        validTo: lastDate,
        spanIds: sorted.flatMap((d) => d.spans),
      });
      if (edge?.changed) edges += 1;
      if (entry.from.companyId === null) continue;
      const crore = (totalRs / 10_000_000).toFixed(2);
      const recorded = await recordEvent(
        tx,
        entry.from.companyId,
        "donation",
        new Date(`${lastDate ?? isoDate(new Date())}T00:00:00+05:30`),
        `Electoral bonds worth ₹${crore} Cr bought by ${entry.from.name} were redeemed by ${entry.party} (${sorted.length} bonds, ${firstDate} to ${lastDate})`,
        [entry.from.companyId, entry.party, totalRs, sorted.length],
        edge ? [edge.id] : [],
      );
      if (recorded) events += 1;
    }
    await tx.execute(sql`
      insert into influence_coverage (company_id, bonds_read_at, resolver_version, updated_at)
      select id, now(), ${INFLUENCE_RESOLVER_VERSION}, now() from companies
      on conflict (company_id) do update
        set bonds_read_at = excluded.bonds_read_at,
            resolver_version = excluded.resolver_version,
            updated_at = excluded.updated_at`);
    return {
      rows: rows.length,
      edges,
      events,
      skipped: match.ambiguous.length,
      purchases: purchases.length,
      redemptions: redemptions.length,
      donations,
      ambiguous: match.ambiguous.length,
    };
  });
  return { ...result("updated", { changed: true, ...out }), ...out };
}
