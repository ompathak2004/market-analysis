import { isoDate, sha256, throwIfAborted } from "@ma/core";
import {
  and,
  companies,
  companyGroupMemberships,
  counterparties,
  counterpartyAliases,
  desc,
  eq,
  evidenceSpans,
  fencedTransaction,
  fundamentals,
  graphNodes,
  gte,
  inArray,
  influenceCoverage,
  influenceEdgeEvidence,
  influenceEdges,
  influenceEventEdges,
  influenceEvents,
  influenceExtractions,
  isNull,
  or,
  ownership,
  personAliases,
  personRoles,
  persons,
  relatedPartyTransactions,
  shareholding,
  sql,
  type Tx,
} from "@ma/db";
import {
  aggregateRpt,
  directorKey,
  type GovernanceDirector,
  type GovernanceFiling,
  type GovernanceReport,
  governanceSnapshot,
  type IngestContext,
  NSE_GOVERNANCE_PARSER_VERSION,
  NSE_RPT_PARSER_VERSION,
  NseGovernanceSource,
  NseRptSource,
  normalizeCompanyName,
  type RptFiling,
  type RptReport,
  rptSnapshot,
} from "@ma/ingest";
import {
  confidenceFor,
  edgeStatus,
  INFLUENCE_EVENT_RULE_VERSION,
  INFLUENCE_RESOLVER_VERSION,
  isMaterialRpt,
  normalizePersonName,
  PERSON_NORMALIZER_VERSION,
  type PersonCandidate,
  RPT_EDGE_CLASSES,
  resolvePerson,
  rptRelationshipClass,
  type SourceKind,
} from "./index.js";

const GOVERNANCE_SOURCE = "nse_governance";
const RPT_SOURCE = "nse_rpt";
const RPT_FILING_ATTEMPTS = 2;
const ERROR_CHARS = 500;

export interface GovernanceSourceLike {
  filings(symbol: string, signal?: AbortSignal): Promise<GovernanceFiling[]>;
  report(filing: GovernanceFiling, signal?: AbortSignal): Promise<GovernanceReport>;
}

export interface RptSourceLike {
  filings(symbol: string, signal?: AbortSignal): Promise<RptFiling[]>;
  report(filing: RptFiling, signal?: AbortSignal): Promise<RptReport>;
}

export type InfluenceSyncStatus = "updated" | "unchanged" | "no_filing" | "no_symbol";

export interface InfluenceSyncResult {
  status: InfluenceSyncStatus;
  changed: boolean;
  rows: number;
  edges: number;
  events: number;
  skipped: number;
}

export interface PerimeterResult {
  changed: boolean;
  promoters: number;
  subsidiaries: number;
  groups: number;
  edges: number;
}

type NodeKind = "person" | "company" | "counterparty";
type EdgeKind = (typeof influenceEdges.$inferInsert)["kind"];
type Span = { start: number; end: number };
type InfluenceFamily = (typeof influenceExtractions.$inferInsert)["family"];

interface EdgeInput {
  fromNodeId: number;
  toNodeId: number;
  kind: EdgeKind;
  fact: { personRoleId?: number; ownershipId?: number; rptId?: number };
  confidence: number;
  source: SourceKind;
  identifier: boolean;
  inputHash: string;
  validFrom: string | null;
  validTo: string | null;
  spanIds: readonly number[];
}

interface EdgeOutcome {
  id: number;
  created: boolean;
  changed: boolean;
}

const result = (
  status: InfluenceSyncStatus,
  counts: Partial<Omit<InfluenceSyncResult, "status">> = {},
): InfluenceSyncResult => ({
  status,
  changed: counts.changed ?? false,
  rows: counts.rows ?? 0,
  edges: counts.edges ?? 0,
  events: counts.events ?? 0,
  skipped: counts.skipped ?? 0,
});

async function companyFor(ctx: IngestContext, companyId: number) {
  const company = await ctx.db.query.companies.findFirst({ where: eq(companies.id, companyId) });
  if (!company) throw new Error(`company ${companyId} not found`);
  return company;
}

async function nodeFor(tx: Tx, kind: NodeKind, id: number): Promise<number> {
  const column =
    kind === "person"
      ? graphNodes.personId
      : kind === "company"
        ? graphNodes.companyId
        : graphNodes.counterpartyId;
  const ref =
    kind === "person"
      ? { personId: id }
      : kind === "company"
        ? { companyId: id }
        : { counterpartyId: id };
  const [inserted] = await tx
    .insert(graphNodes)
    .values({ kind, ...ref })
    .onConflictDoNothing({ target: column })
    .returning({ id: graphNodes.id });
  if (inserted) return inserted.id;
  const [row] = await tx.select({ id: graphNodes.id }).from(graphNodes).where(eq(column, id));
  if (!row) throw new Error(`graph node ${kind}:${id} missing`);
  return row.id;
}

async function spanFor(
  tx: Tx,
  revisionId: number,
  content: string,
  span: Span | undefined,
  locator: Record<string, unknown>,
): Promise<number | null> {
  if (!span || span.end <= span.start) return null;
  const [inserted] = await tx
    .insert(evidenceSpans)
    .values({
      documentRevisionId: revisionId,
      startOffset: span.start,
      endOffset: span.end,
      quote: content.slice(span.start, span.end),
      locator,
    })
    .onConflictDoNothing({
      target: [
        evidenceSpans.documentRevisionId,
        evidenceSpans.startOffset,
        evidenceSpans.endOffset,
      ],
    })
    .returning({ id: evidenceSpans.id });
  if (inserted) return inserted.id;
  const [row] = await tx
    .select({ id: evidenceSpans.id })
    .from(evidenceSpans)
    .where(
      and(
        eq(evidenceSpans.documentRevisionId, revisionId),
        eq(evidenceSpans.startOffset, span.start),
        eq(evidenceSpans.endOffset, span.end),
      ),
    );
  return row?.id ?? null;
}

async function upsertEdge(tx: Tx, e: EdgeInput): Promise<EdgeOutcome | null> {
  const existing = await tx
    .select({
      id: influenceEdges.id,
      status: influenceEdges.status,
      inputHash: influenceEdges.inputHash,
    })
    .from(influenceEdges)
    .where(
      and(
        eq(influenceEdges.fromNodeId, e.fromNodeId),
        eq(influenceEdges.toNodeId, e.toNodeId),
        eq(influenceEdges.kind, e.kind),
        inArray(influenceEdges.status, ["confirmed", "pending", "rejected"]),
      ),
    )
    .orderBy(desc(influenceEdges.updatedAt));
  const live =
    existing.find((r) => r.status === "confirmed") ?? existing.find((r) => r.status === "pending");
  const rejected = existing.find((r) => r.status === "rejected");
  const ruled = edgeStatus({
    confidence: e.confidence,
    source: e.source,
    identifier: e.identifier,
  });
  const fact = {
    personRoleId: e.fact.personRoleId ?? null,
    ownershipId: e.fact.ownershipId ?? null,
    rptId: e.fact.rptId ?? null,
  };
  let outcome: EdgeOutcome;
  if (live) {
    const changed = live.inputHash !== e.inputHash;
    if (changed) {
      const promote = live.status === "pending" && ruled === "confirmed";
      await tx
        .update(influenceEdges)
        .set({
          ...fact,
          confidence: e.confidence,
          resolverVersion: INFLUENCE_RESOLVER_VERSION,
          inputHash: e.inputHash,
          validFrom: e.validFrom,
          validTo: e.validTo,
          updatedAt: new Date(),
          ...(promote
            ? { status: "confirmed" as const, version: sql`${influenceEdges.version} + 1` }
            : {}),
        })
        .where(eq(influenceEdges.id, live.id));
    }
    outcome = { id: live.id, created: false, changed };
  } else {
    if (rejected && rejected.inputHash === e.inputHash) return null;
    const [row] = await tx
      .insert(influenceEdges)
      .values({
        fromNodeId: e.fromNodeId,
        toNodeId: e.toNodeId,
        kind: e.kind,
        ...fact,
        confidence: e.confidence,
        status: rejected ? "pending" : ruled,
        resolverVersion: INFLUENCE_RESOLVER_VERSION,
        inputHash: e.inputHash,
        validFrom: e.validFrom,
        validTo: e.validTo,
      })
      .returning({ id: influenceEdges.id });
    if (!row) throw new Error("influence edge insert failed");
    outcome = { id: row.id, created: true, changed: true };
  }
  if (e.spanIds.length) {
    await tx
      .insert(influenceEdgeEvidence)
      .values(
        [...new Set(e.spanIds)].map((evidenceSpanId) => ({ edgeId: outcome.id, evidenceSpanId })),
      )
      .onConflictDoNothing();
  }
  return outcome;
}

async function recordEvent(
  tx: Tx,
  companyId: number,
  kind: (typeof influenceEvents.$inferInsert)["kind"],
  occurredAt: Date,
  summary: string,
  key: readonly (string | number | null)[],
  edgeIds: readonly number[],
): Promise<boolean> {
  const [event] = await tx
    .insert(influenceEvents)
    .values({
      companyId,
      kind,
      occurredAt,
      summary,
      ruleVersion: INFLUENCE_EVENT_RULE_VERSION,
      inputHash: sha256([INFLUENCE_EVENT_RULE_VERSION, ...key].join("|")),
    })
    .onConflictDoNothing({
      target: [influenceEvents.companyId, influenceEvents.kind, influenceEvents.inputHash],
    })
    .returning({ id: influenceEvents.id });
  if (!event) return false;
  if (edgeIds.length) {
    await tx
      .insert(influenceEventEdges)
      .values(edgeIds.map((edgeId) => ({ eventId: event.id, edgeId })))
      .onConflictDoNothing();
  }
  return true;
}

async function touchCoverage(
  db: Pick<Tx, "insert">,
  companyId: number,
  set: Partial<
    Pick<
      typeof influenceCoverage.$inferInsert,
      "governanceReadAt" | "rptReadAt" | "perimeterReadAt"
    >
  >,
) {
  const values = { ...set, resolverVersion: INFLUENCE_RESOLVER_VERSION, updatedAt: new Date() };
  await db
    .insert(influenceCoverage)
    .values({ companyId, ...values })
    .onConflictDoUpdate({ target: influenceCoverage.companyId, set: values });
}

interface Extraction {
  documentRevisionId: number;
  companyId: number;
  family: InfluenceFamily;
  version: number;
  inputHash: string;
}

const extractionKey = (x: Extraction) =>
  and(
    eq(influenceExtractions.documentRevisionId, x.documentRevisionId),
    eq(influenceExtractions.family, x.family),
    eq(influenceExtractions.version, x.version),
    eq(influenceExtractions.inputHash, x.inputHash),
  );

async function alreadyExtracted(ctx: IngestContext, x: Extraction): Promise<boolean> {
  const [row] = await ctx.db
    .select({ id: influenceExtractions.id })
    .from(influenceExtractions)
    .where(and(extractionKey(x), eq(influenceExtractions.status, "succeeded")));
  return Boolean(row);
}

async function startExtraction(tx: Tx, x: Extraction) {
  await tx
    .insert(influenceExtractions)
    .values({ ...x, status: "running" })
    .onConflictDoUpdate({
      target: [
        influenceExtractions.documentRevisionId,
        influenceExtractions.family,
        influenceExtractions.version,
        influenceExtractions.inputHash,
      ],
      set: { status: "running", startedAt: new Date(), finishedAt: null, error: null },
    });
}

async function finishExtraction(tx: Tx, x: Extraction, rows: number) {
  await tx
    .update(influenceExtractions)
    .set({ status: "succeeded", rows, finishedAt: new Date() })
    .where(extractionKey(x));
}

async function failExtraction(ctx: IngestContext, x: Extraction, err: unknown) {
  const error = (err instanceof Error ? err.message : String(err)).slice(0, ERROR_CHARS);
  await ctx.db
    .insert(influenceExtractions)
    .values({ ...x, status: "failed", error, finishedAt: new Date() })
    .onConflictDoUpdate({
      target: [
        influenceExtractions.documentRevisionId,
        influenceExtractions.family,
        influenceExtractions.version,
        influenceExtractions.inputHash,
      ],
      set: { status: "failed", error, finishedAt: new Date() },
    });
}

async function runExtraction<T>(
  ctx: IngestContext,
  x: Extraction,
  signal: AbortSignal | undefined,
  fn: (tx: Tx) => Promise<T & { rows: number }>,
): Promise<T & { rows: number }> {
  try {
    return await fencedTransaction(
      ctx.db,
      async (tx) => {
        await startExtraction(tx, x);
        const out = await fn(tx);
        await finishExtraction(tx, x, out.rows);
        return out;
      },
      signal,
    );
  } catch (err) {
    if (!signal?.aborted) await failExtraction(ctx, x, err).catch(() => undefined);
    throw err;
  }
}

async function personCandidates(
  tx: Tx,
  dins: readonly string[],
  personIds: readonly number[],
): Promise<PersonCandidate[]> {
  const filters = [
    ...(dins.length ? [inArray(persons.din, [...dins])] : []),
    ...(personIds.length ? [inArray(persons.id, [...personIds])] : []),
  ];
  if (!filters.length) return [];
  const rows = await tx
    .select({ id: persons.id, din: persons.din, normalizedName: persons.normalizedName })
    .from(persons)
    .where(or(...filters));
  const aliases = rows.length
    ? await tx
        .select({ personId: personAliases.personId, alias: personAliases.normalizedAlias })
        .from(personAliases)
        .where(
          inArray(
            personAliases.personId,
            rows.map((r) => r.id),
          ),
        )
    : [];
  return rows.map((r) => ({
    ...r,
    aliases: aliases.filter((a) => a.personId === r.id).map((a) => a.alias),
  }));
}

async function createPerson(tx: Tx, d: GovernanceDirector): Promise<number> {
  const values = {
    din: d.din,
    canonicalName: d.name,
    normalizedName: normalizePersonName(d.name),
    birthYear: d.birthYear,
  };
  const [row] = d.din
    ? await tx
        .insert(persons)
        .values(values)
        .onConflictDoUpdate({
          target: persons.din,
          targetWhere: sql`${persons.din} is not null`,
          set: { updatedAt: new Date() },
        })
        .returning({ id: persons.id })
    : await tx.insert(persons).values(values).returning({ id: persons.id });
  if (!row) throw new Error(`person insert failed for ${d.name}`);
  return row.id;
}

async function addAlias(tx: Tx, personId: number, alias: string, source: string) {
  await tx
    .insert(personAliases)
    .values({ personId, alias, normalizedAlias: normalizePersonName(alias), source })
    .onConflictDoNothing();
}

const ROLE_LABEL: Record<GovernanceDirector["role"], string> = {
  chairman: "chairperson",
  md: "managing director",
  ceo: "chief executive",
  cfo: "chief financial officer",
  independent_director: "independent director",
  director: "director",
  promoter: "promoter",
  kmp: "key managerial person",
  other: "director",
};

const asDate = (day: string | null | undefined, fallback: Date | null): Date =>
  day ? new Date(`${day}T00:00:00+05:30`) : (fallback ?? new Date());

export async function syncGovernance(
  ctx: IngestContext,
  companyId: number,
  opts: { signal?: AbortSignal; source?: GovernanceSourceLike } = {},
): Promise<InfluenceSyncResult> {
  const { signal } = opts;
  const company = await companyFor(ctx, companyId);
  if (!company.nseSymbol) return result("no_symbol");
  const source = opts.source ?? new NseGovernanceSource(ctx.http, ctx.config.NSE_BASE_URL);
  const [filing] = await source.filings(company.nseSymbol, signal);
  if (!filing) {
    await touchCoverage(ctx.db, companyId, { governanceReadAt: new Date() });
    return result("no_filing");
  }
  const report = await source.report(filing, signal);
  throwIfAborted(signal);
  const snap = governanceSnapshot(filing, report);
  const { revision } = await ctx.docs.putInline(filing.xbrlUrl, snap.content, {
    source: GOVERNANCE_SOURCE,
    companyId,
    publishedAt: filing.submittedAt,
    contentType: "application/json",
    ...(signal ? { signal } : {}),
  });
  const extraction: Extraction = {
    documentRevisionId: revision.id,
    companyId,
    family: "nse_governance",
    version: NSE_GOVERNANCE_PARSER_VERSION,
    inputHash: sha256(
      [
        revision.contentSha256,
        NSE_GOVERNANCE_PARSER_VERSION,
        PERSON_NORMALIZER_VERSION,
        INFLUENCE_RESOLVER_VERSION,
        INFLUENCE_EVENT_RULE_VERSION,
      ].join(":"),
    ),
  };
  if (await alreadyExtracted(ctx, extraction)) {
    await touchCoverage(ctx.db, companyId, { governanceReadAt: new Date() });
    return result("unchanged");
  }
  const periodEnd = report.periodEnd ?? filing.periodEnd;

  const out = await runExtraction(ctx, extraction, signal, async (tx) => {
    const companyNode = await nodeFor(tx, "company", companyId);
    const previous = await tx
      .select({
        id: personRoles.id,
        personId: personRoles.personId,
        dedupeKey: personRoles.dedupeKey,
        status: personRoles.status,
        name: persons.canonicalName,
      })
      .from(personRoles)
      .innerJoin(persons, eq(persons.id, personRoles.personId))
      .where(
        and(eq(personRoles.companyId, companyId), eq(personRoles.dinSource, GOVERNANCE_SOURCE)),
      );
    const previousByKey = new Map(previous.map((p) => [p.dedupeKey, p]));
    const firstRead = previous.length === 0;
    const candidates = await personCandidates(
      tx,
      report.directors.flatMap((d) => (d.din ? [d.din] : [])),
      previous.map((p) => p.personId),
    );
    const seen = new Set<string>();
    let edges = 0;
    let events = 0;
    let skipped = 0;

    for (const d of report.directors) {
      const resolution = resolvePerson(
        { name: d.name, din: d.din, source: "structured_primary" },
        candidates,
      );
      if (resolution.basis === "ambiguous") {
        skipped += 1;
        continue;
      }
      let personId = resolution.personId;
      if (personId === null) {
        personId = await createPerson(tx, d);
        candidates.push({ id: personId, din: d.din, normalizedName: normalizePersonName(d.name) });
      }
      await addAlias(tx, personId, d.name, GOVERNANCE_SOURCE);
      const spanId = await spanFor(tx, revision.id, snap.content, snap.spans.get(directorKey(d)), {
        kind: "director",
        din: d.din,
      });
      const dedupeKey = `${GOVERNANCE_SOURCE}:${companyId}:${personId}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      const toDate = d.status === "past" ? (d.ceasedOn ?? periodEnd) : null;
      const fromDate = d.appointedOn && (!toDate || d.appointedOn <= toDate) ? d.appointedOn : null;
      const fields = {
        role: d.role,
        category: d.category,
        dinSource: GOVERNANCE_SOURCE,
        fromDate,
        toDate,
        documentRevisionId: revision.id,
        evidenceSpanId: spanId,
        status: d.status,
      };
      const [role] = await tx
        .insert(personRoles)
        .values({ personId, companyId, dedupeKey, ...fields })
        .onConflictDoUpdate({
          target: personRoles.dedupeKey,
          set: { ...fields, updatedAt: new Date() },
        })
        .returning({ id: personRoles.id });
      if (!role) throw new Error(`person role upsert failed for ${d.name}`);
      const personNode = await nodeFor(tx, "person", personId);
      const edge = await upsertEdge(tx, {
        fromNodeId: personNode,
        toNodeId: companyNode,
        kind: "director_of",
        fact: { personRoleId: role.id },
        confidence: resolution.confidence,
        source: "structured_primary",
        identifier: resolution.identifier,
        inputHash: sha256(JSON.stringify([d.din, d.role, d.status, fromDate, toDate, d.category])),
        validFrom: fromDate,
        validTo: toDate,
        spanIds: spanId ? [spanId] : [],
      });
      if (edge?.changed) edges += 1;
      if (firstRead) continue;
      const prev = previousByKey.get(dedupeKey);
      const joined = d.status === "current" && (!prev || prev.status === "past");
      const left = d.status === "past" && prev?.status === "current";
      if (!joined && !left) continue;
      const summary = joined
        ? `${d.name} joined the board as ${ROLE_LABEL[d.role]}`
        : `${d.name} left the board`;
      const occurredAt = joined
        ? asDate(d.appointedOn, filing.submittedAt)
        : asDate(toDate, filing.submittedAt);
      const recorded = await recordEvent(
        tx,
        companyId,
        "director_change",
        occurredAt,
        summary,
        [personId, joined ? "joined" : "left", joined ? fromDate : toDate],
        edge ? [edge.id] : [],
      );
      if (recorded) events += 1;
    }

    const gone = previous.filter((p) => p.status === "current" && !seen.has(p.dedupeKey));
    if (gone.length) {
      const ids = gone.map((p) => p.id);
      await tx
        .update(personRoles)
        .set({ status: "past", toDate: periodEnd, updatedAt: new Date() })
        .where(inArray(personRoles.id, ids));
      const closed = await tx
        .update(influenceEdges)
        .set({ validTo: periodEnd, updatedAt: new Date() })
        .where(
          and(
            inArray(influenceEdges.personRoleId, ids),
            isNull(influenceEdges.validTo),
            or(isNull(influenceEdges.validFrom), sql`${influenceEdges.validFrom} <= ${periodEnd}`),
          ),
        )
        .returning({ id: influenceEdges.id, personRoleId: influenceEdges.personRoleId });
      edges += closed.length;
      for (const p of gone) {
        const edgeIds = closed.filter((c) => c.personRoleId === p.id).map((c) => c.id);
        const recorded = await recordEvent(
          tx,
          companyId,
          "director_change",
          asDate(periodEnd, filing.submittedAt),
          `${p.name} no longer listed on the board`,
          [p.personId, "left", periodEnd],
          edgeIds,
        );
        if (recorded) events += 1;
      }
    }

    await touchCoverage(tx, companyId, { governanceReadAt: new Date() });
    return { rows: seen.size, edges, events, skipped };
  });
  return result("updated", { changed: true, ...out });
}

async function latestRevenueCr(ctx: IngestContext, companyId: number): Promise<number | null> {
  const [row] = await ctx.db
    .select({ revenue: fundamentals.revenue })
    .from(fundamentals)
    .where(and(eq(fundamentals.companyId, companyId), eq(fundamentals.periodType, "annual")))
    .orderBy(desc(fundamentals.periodEnd))
    .limit(1);
  return row?.revenue == null ? null : Number(row.revenue);
}

async function listedCompanyIndex(ctx: IngestContext): Promise<Map<string, number>> {
  const rows = await ctx.db.select({ id: companies.id, name: companies.name }).from(companies);
  const out = new Map<string, number>();
  for (const r of rows) {
    const key = normalizeCompanyName(r.name);
    if (key) out.set(key, r.id);
  }
  return out;
}

async function counterpartyFor(
  tx: Tx,
  name: string,
  listed: ReadonlyMap<string, number>,
  selfCompanyId: number,
): Promise<number | null> {
  const normalized = normalizeCompanyName(name);
  if (!normalized) return null;
  const listedId = listed.get(normalized) ?? null;
  if (listedId === selfCompanyId) return null;
  const [hit] = await tx
    .select({ id: counterparties.id })
    .from(counterparties)
    .where(eq(counterparties.normalizedName, normalized));
  if (hit) return hit.id;
  const [alias] = await tx
    .select({ id: counterpartyAliases.counterpartyId })
    .from(counterpartyAliases)
    .where(
      and(
        eq(counterpartyAliases.normalizedAlias, normalized),
        eq(counterpartyAliases.approved, true),
      ),
    );
  if (alias) return alias.id;
  if (listedId !== null) {
    const [byCompany] = await tx
      .select({ id: counterparties.id })
      .from(counterparties)
      .where(eq(counterparties.companyId, listedId));
    if (byCompany) return byCompany.id;
  }
  const [created] = await tx
    .insert(counterparties)
    .values({
      kind: listedId !== null ? "listed" : "private",
      canonicalName: name.trim(),
      normalizedName: normalized,
      companyId: listedId,
    })
    .onConflictDoNothing()
    .returning({ id: counterparties.id });
  if (created) return created.id;
  const [again] = await tx
    .select({ id: counterparties.id })
    .from(counterparties)
    .where(eq(counterparties.normalizedName, normalized));
  return again?.id ?? null;
}

async function companyPeople(tx: Tx, companyId: number): Promise<PersonCandidate[]> {
  const rows = await tx
    .selectDistinct({ personId: personRoles.personId })
    .from(personRoles)
    .where(eq(personRoles.companyId, companyId));
  return personCandidates(
    tx,
    [],
    rows.map((r) => r.personId),
  );
}

const crore = (n: number | null) => (n == null ? null : n.toFixed(2));

export async function syncRelatedParties(
  ctx: IngestContext,
  companyId: number,
  opts: { signal?: AbortSignal; source?: RptSourceLike } = {},
): Promise<InfluenceSyncResult> {
  const { signal } = opts;
  const company = await companyFor(ctx, companyId);
  if (!company.nseSymbol) return result("no_symbol");
  const source = opts.source ?? new NseRptSource(ctx.http, ctx.config.NSE_BASE_URL);
  const filings = await source.filings(company.nseSymbol, signal);
  let picked: { filing: RptFiling; report: RptReport } | null = null;
  for (const filing of filings.slice(0, RPT_FILING_ATTEMPTS)) {
    const report = await source.report(filing, signal);
    if (report.rows.length) {
      picked = { filing, report };
      break;
    }
  }
  if (!picked) {
    await touchCoverage(ctx.db, companyId, { rptReadAt: new Date() });
    return result("no_filing");
  }
  const { filing, report } = picked;
  throwIfAborted(signal);
  const aggregates = aggregateRpt(report, report.companyName ?? company.name);
  const snap = rptSnapshot(filing, report, aggregates);
  const { revision } = await ctx.docs.putInline(filing.xbrlUrl, snap.content, {
    source: RPT_SOURCE,
    companyId,
    publishedAt: filing.submittedAt,
    contentType: "application/json",
    ...(signal ? { signal } : {}),
  });
  const extraction: Extraction = {
    documentRevisionId: revision.id,
    companyId,
    family: "nse_rpt",
    version: NSE_RPT_PARSER_VERSION,
    inputHash: sha256(
      [
        revision.contentSha256,
        NSE_RPT_PARSER_VERSION,
        PERSON_NORMALIZER_VERSION,
        INFLUENCE_RESOLVER_VERSION,
        INFLUENCE_EVENT_RULE_VERSION,
      ].join(":"),
    ),
  };
  if (await alreadyExtracted(ctx, extraction)) {
    await touchCoverage(ctx.db, companyId, { rptReadAt: new Date() });
    return result("unchanged");
  }
  const periodStart = report.periodStart ?? filing.periodStart;
  const periodEnd = report.periodEnd ?? filing.periodEnd;
  const revenue = await latestRevenueCr(ctx, companyId);
  const listed = await listedCompanyIndex(ctx);

  const out = await runExtraction(ctx, extraction, signal, async (tx) => {
    const companyNode = await nodeFor(tx, "company", companyId);
    const people = await companyPeople(tx, companyId);
    const pairs = new Map<
      number,
      { rptId: number; value: number; spanIds: number[]; confidence: number }
    >();
    const material: Array<{
      targetNode: number | null;
      rptId: number;
      key: string;
      value: number;
      summary: string;
    }> = [];
    let skipped = 0;

    for (const a of aggregates) {
      const cls = rptRelationshipClass(a.relationship);
      let counterpartyId: number | null = null;
      let targetNode: number | null = null;
      let confidence = 0;
      if (cls === "kmp") {
        const r = resolvePerson(
          { name: a.counterparty, source: "structured_primary", independentDocuments: 2 },
          people,
        );
        if (r.personId !== null) {
          targetNode = await nodeFor(tx, "person", r.personId);
          confidence = r.confidence;
        } else skipped += 1;
      } else if (cls !== "employee_benefit") {
        counterpartyId = await counterpartyFor(tx, a.counterparty, listed, companyId);
        if (counterpartyId !== null) {
          targetNode = await nodeFor(tx, "counterparty", counterpartyId);
          confidence = confidenceFor("name_only", "structured_primary");
        }
      }
      const spanId = await spanFor(tx, revision.id, snap.content, snap.spans.get(a.key), {
        kind: "related_party_transaction",
        period: periodEnd,
      });
      const dedupeKey = `${RPT_SOURCE}:${companyId}:${periodEnd}:${a.key}`;
      const [prior] = await tx
        .select({ valueCr: relatedPartyTransactions.valueCr })
        .from(relatedPartyTransactions)
        .where(eq(relatedPartyTransactions.dedupeKey, dedupeKey));
      const fields = {
        counterpartyId,
        counterpartyName: a.counterparty,
        relationship: a.relationship,
        transactionType: a.transactionType,
        valueCr: crore(a.valueCr),
        periodStart,
        periodEnd,
        scope: a.scope,
        source: RPT_SOURCE,
        documentRevisionId: revision.id,
        evidenceSpanId: spanId,
      };
      const [row] = await tx
        .insert(relatedPartyTransactions)
        .values({ companyId, dedupeKey, ...fields })
        .onConflictDoUpdate({
          target: relatedPartyTransactions.dedupeKey,
          set: { ...fields, updatedAt: new Date() },
        })
        .returning({ id: relatedPartyTransactions.id });
      if (!row) throw new Error(`related party upsert failed for ${a.counterparty}`);
      if (targetNode !== null && RPT_EDGE_CLASSES.has(cls)) {
        const pair = pairs.get(targetNode);
        const value = a.valueCr ?? 0;
        if (!pair) {
          pairs.set(targetNode, {
            rptId: row.id,
            value,
            spanIds: spanId ? [spanId] : [],
            confidence,
          });
        } else {
          if (value > pair.value) {
            pair.rptId = row.id;
            pair.value = value;
          }
          if (spanId) pair.spanIds.push(spanId);
        }
      }
      const changedValue =
        !prior || crore(a.valueCr) !== crore(prior.valueCr == null ? null : Number(prior.valueCr));
      if (
        a.valueCr != null &&
        changedValue &&
        RPT_EDGE_CLASSES.has(cls) &&
        isMaterialRpt(a.valueCr, revenue)
      ) {
        material.push({
          targetNode,
          rptId: row.id,
          key: dedupeKey,
          value: a.valueCr,
          summary: `${a.counterparty} (${a.relationship ?? "related party"}): ${a.transactionType ?? "transaction"} ₹${a.valueCr.toFixed(2)} Cr, ${periodStart ?? "?"} to ${periodEnd}`,
        });
      }
    }

    let edges = 0;
    const edgeByNode = new Map<number, number>();
    for (const [targetNode, pair] of pairs) {
      const edge = await upsertEdge(tx, {
        fromNodeId: companyNode,
        toNodeId: targetNode,
        kind: "related_party",
        fact: { rptId: pair.rptId },
        confidence: pair.confidence,
        source: "structured_primary",
        identifier: false,
        inputHash: sha256(JSON.stringify([periodEnd, pair.rptId, pair.value, pair.spanIds.length])),
        validFrom: periodStart,
        validTo: null,
        spanIds: pair.spanIds,
      });
      if (edge) {
        edgeByNode.set(targetNode, edge.id);
        if (edge.changed) edges += 1;
      }
    }

    let events = 0;
    for (const m of material) {
      const edgeId = m.targetNode === null ? undefined : edgeByNode.get(m.targetNode);
      const recorded = await recordEvent(
        tx,
        companyId,
        "material_rpt",
        filing.submittedAt ?? asDate(periodEnd, null),
        m.summary,
        [m.key, m.value.toFixed(2)],
        edgeId === undefined ? [] : [edgeId],
      );
      if (recorded) events += 1;
    }

    await touchCoverage(tx, companyId, { rptReadAt: new Date() });
    return { rows: aggregates.length, edges, events, skipped };
  });
  return result("updated", { changed: true, ...out });
}

async function groupCounterparty(tx: Tx, groupKey: string): Promise<number | null> {
  const [hit] = await tx
    .select({ id: counterparties.id })
    .from(counterparties)
    .where(and(eq(counterparties.kind, "group"), eq(counterparties.groupKey, groupKey)));
  if (hit) return hit.id;
  const label = `${groupKey
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w[0]?.toUpperCase() + w.slice(1))
    .join(" ")} Group`;
  const normalized = normalizeCompanyName(label);
  const [created] = await tx
    .insert(counterparties)
    .values({ kind: "group", canonicalName: label, normalizedName: normalized, groupKey })
    .onConflictDoNothing()
    .returning({ id: counterparties.id });
  if (created) return created.id;
  const [byName] = await tx
    .select({ id: counterparties.id })
    .from(counterparties)
    .where(eq(counterparties.normalizedName, normalized));
  return byName?.id ?? null;
}

async function ownershipRow(
  tx: Tx,
  values: Omit<typeof ownership.$inferInsert, "id" | "createdAt">,
): Promise<number> {
  const [row] = await tx
    .insert(ownership)
    .values(values)
    .onConflictDoUpdate({
      target: [ownership.holderNodeId, ownership.targetNodeId, ownership.asOf, ownership.source],
      set: { pct: values.pct ?? null, documentRevisionId: values.documentRevisionId ?? null },
    })
    .returning({ id: ownership.id });
  if (!row) throw new Error("ownership upsert failed");
  return row.id;
}

export async function syncPerimeter(
  ctx: IngestContext,
  companyId: number,
  signal?: AbortSignal,
): Promise<PerimeterResult> {
  await companyFor(ctx, companyId);
  const [latest] = await ctx.db
    .select({ periodEnd: relatedPartyTransactions.periodEnd })
    .from(relatedPartyTransactions)
    .where(
      and(
        eq(relatedPartyTransactions.companyId, companyId),
        eq(relatedPartyTransactions.source, RPT_SOURCE),
      ),
    )
    .orderBy(desc(relatedPartyTransactions.periodEnd))
    .limit(1);
  const rpt = latest?.periodEnd
    ? await ctx.db
        .select({
          id: relatedPartyTransactions.id,
          counterpartyId: relatedPartyTransactions.counterpartyId,
          relationship: relatedPartyTransactions.relationship,
          scope: relatedPartyTransactions.scope,
          valueCr: relatedPartyTransactions.valueCr,
          evidenceSpanId: relatedPartyTransactions.evidenceSpanId,
          documentRevisionId: relatedPartyTransactions.documentRevisionId,
          periodStart: relatedPartyTransactions.periodStart,
        })
        .from(relatedPartyTransactions)
        .where(
          and(
            eq(relatedPartyTransactions.companyId, companyId),
            eq(relatedPartyTransactions.source, RPT_SOURCE),
            eq(relatedPartyTransactions.periodEnd, latest.periodEnd),
          ),
        )
        .orderBy(relatedPartyTransactions.id)
    : [];
  const today = isoDate(new Date());
  const groups = await ctx.db
    .select({ groupKey: companyGroupMemberships.groupKey, source: companyGroupMemberships.source })
    .from(companyGroupMemberships)
    .where(
      and(
        eq(companyGroupMemberships.companyId, companyId),
        or(isNull(companyGroupMemberships.validTo), gte(companyGroupMemberships.validTo, today)),
      ),
    )
    .orderBy(companyGroupMemberships.groupKey);
  const [promoter] = await ctx.db
    .select({ quarterEnd: shareholding.quarterEnd, pct: shareholding.pct })
    .from(shareholding)
    .where(and(eq(shareholding.companyId, companyId), eq(shareholding.holder, "promoter")))
    .orderBy(desc(shareholding.quarterEnd))
    .limit(1);

  const byCounterparty = (cls: "holding" | "subsidiary") => {
    const out = new Map<number, typeof rpt>();
    for (const r of rpt) {
      if (r.counterpartyId === null || rptRelationshipClass(r.relationship) !== cls) continue;
      if (cls === "subsidiary" && r.scope !== "listed") continue;
      out.set(r.counterpartyId, [...(out.get(r.counterpartyId) ?? []), r]);
    }
    return out;
  };
  const holdings = byCounterparty("holding");
  const subsidiaries = byCounterparty("subsidiary");
  const asOf = latest?.periodEnd ?? null;
  const nameConfidence = confidenceFor("name_only", "structured_primary");

  return fencedTransaction(
    ctx.db,
    async (tx) => {
      const companyNode = await nodeFor(tx, "company", companyId);
      let edges = 0;
      const count = (e: EdgeOutcome | null) => {
        if (e?.changed) edges += 1;
      };
      const spansOf = (rows: typeof rpt) =>
        rows.flatMap((r) => (r.evidenceSpanId ? [r.evidenceSpanId] : []));

      for (const [counterpartyId, rows] of holdings) {
        const node = await nodeFor(tx, "counterparty", counterpartyId);
        const first = rows[0] as (typeof rpt)[number];
        count(
          await upsertEdge(tx, {
            fromNodeId: node,
            toNodeId: companyNode,
            kind: "promoter_of",
            fact: { rptId: first.id },
            confidence: nameConfidence,
            source: "structured_primary",
            identifier: false,
            inputHash: sha256(JSON.stringify(["holding", asOf, rows.map((r) => r.id)])),
            validFrom: first.periodStart,
            validTo: null,
            spanIds: spansOf(rows),
          }),
        );
      }

      for (const [counterpartyId, rows] of subsidiaries) {
        if (!asOf) break;
        const node = await nodeFor(tx, "counterparty", counterpartyId);
        const first = rows[0] as (typeof rpt)[number];
        const ownershipId = await ownershipRow(tx, {
          holderNodeId: companyNode,
          targetNodeId: node,
          pct: null,
          asOf,
          source: RPT_SOURCE,
          documentRevisionId: first.documentRevisionId,
        });
        count(
          await upsertEdge(tx, {
            fromNodeId: companyNode,
            toNodeId: node,
            kind: "owns",
            fact: { ownershipId },
            confidence: nameConfidence,
            source: "structured_primary",
            identifier: false,
            inputHash: sha256(JSON.stringify(["subsidiary", asOf, rows.map((r) => r.id)])),
            validFrom: first.periodStart,
            validTo: null,
            spanIds: spansOf(rows),
          }),
        );
      }

      for (const g of groups) {
        const counterpartyId = await groupCounterparty(tx, g.groupKey);
        if (counterpartyId === null) continue;
        const node = await nodeFor(tx, "counterparty", counterpartyId);
        const ownershipId = promoter
          ? await ownershipRow(tx, {
              holderNodeId: node,
              targetNodeId: companyNode,
              pct: promoter.pct,
              asOf: promoter.quarterEnd,
              source: "shareholding",
              documentRevisionId: null,
            })
          : null;
        count(
          await upsertEdge(tx, {
            fromNodeId: node,
            toNodeId: companyNode,
            kind: "promoter_of",
            fact: ownershipId === null ? {} : { ownershipId },
            confidence: confidenceFor("name_only", "primary"),
            source: "primary",
            identifier: false,
            inputHash: sha256(
              JSON.stringify(["group", g.groupKey, g.source, promoter?.quarterEnd, promoter?.pct]),
            ),
            validFrom: null,
            validTo: null,
            spanIds: [],
          }),
        );
      }

      await touchCoverage(tx, companyId, { perimeterReadAt: new Date() });
      return {
        changed: edges > 0,
        promoters: holdings.size,
        subsidiaries: subsidiaries.size,
        groups: groups.length,
        edges,
      };
    },
    signal,
  );
}
