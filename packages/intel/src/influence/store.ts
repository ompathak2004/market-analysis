import {
  and,
  companies,
  desc,
  eq,
  evidenceSpans,
  fencedTransaction,
  graphNodes,
  inArray,
  influenceCoverage,
  influenceEdgeEvidence,
  influenceEdges,
  influenceEventEdges,
  influenceEvents,
  influenceExtractions,
  or,
  personAliases,
  personIdentifiers,
  persons,
  sql,
  type Tx,
} from "@ma/db";
import { type IngestContext, normalizeCompanyName } from "@ma/ingest";
import { eventInputHash } from "./events.js";
import { normalizePersonName } from "./normalize.js";
import { INFLUENCE_RESOLVER_VERSION } from "./resolve.js";
import { edgeStatus, INFLUENCE_EVENT_RULE_VERSION } from "./rules.js";
import type { PersonCandidate, SourceKind } from "./types.js";

const ERROR_CHARS = 500;
export type InfluenceSyncStatus = "updated" | "unchanged" | "no_filing" | "no_symbol";

export interface InfluenceSyncResult {
  status: InfluenceSyncStatus;
  changed: boolean;
  rows: number;
  edges: number;
  events: number;
  skipped: number;
}

export type NodeKind = "person" | "company" | "counterparty";
export type EdgeKind = (typeof influenceEdges.$inferInsert)["kind"];
export type Span = { start: number; end: number };
export type InfluenceFamily = (typeof influenceExtractions.$inferInsert)["family"];

export interface EdgeInput {
  fromNodeId: number;
  toNodeId: number;
  kind: EdgeKind;
  fact: {
    personRoleId?: number;
    ownershipId?: number;
    rptId?: number;
    politicalRoleId?: number;
    affidavitInterestId?: number;
    donationId?: number;
    policyEventTagId?: number;
  };
  confidence: number;
  source: SourceKind;
  identifier: boolean;
  inputHash: string;
  validFrom: string | null;
  validTo: string | null;
  spanIds: readonly number[];
}

export interface EdgeOutcome {
  id: number;
  created: boolean;
  changed: boolean;
}

export const result = (
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

type NodeRef =
  | { kind: "person"; personId: number }
  | { kind: "company"; companyId: number }
  | { kind: "counterparty"; counterpartyId: number }
  | { kind: "policy_event"; policyEventId: number }
  | { kind: "policy_sector"; sectorKey: string }
  | { kind: "party"; partyName: string };

function nodeColumn(ref: NodeRef) {
  switch (ref.kind) {
    case "person":
      return { column: graphNodes.personId, value: ref.personId };
    case "company":
      return { column: graphNodes.companyId, value: ref.companyId };
    case "counterparty":
      return { column: graphNodes.counterpartyId, value: ref.counterpartyId };
    case "policy_event":
      return { column: graphNodes.policyEventId, value: ref.policyEventId };
    case "policy_sector":
      return { column: graphNodes.sectorKey, value: ref.sectorKey };
    case "party":
      return { column: graphNodes.partyName, value: ref.partyName };
  }
}

export async function nodeOf(tx: Tx, ref: NodeRef): Promise<number> {
  const { column, value } = nodeColumn(ref);
  const [inserted] = await tx
    .insert(graphNodes)
    .values(ref)
    .onConflictDoNothing({ target: column })
    .returning({ id: graphNodes.id });
  if (inserted) return inserted.id;
  const [row] = await tx.select({ id: graphNodes.id }).from(graphNodes).where(eq(column, value));
  if (!row) throw new Error(`graph node ${ref.kind}:${value} missing`);
  return row.id;
}

export async function nodeFor(tx: Tx, kind: NodeKind, id: number): Promise<number> {
  return nodeOf(
    tx,
    kind === "person"
      ? { kind, personId: id }
      : kind === "company"
        ? { kind, companyId: id }
        : { kind, counterpartyId: id },
  );
}

export async function spanFor(
  tx: Tx,
  revisionId: number,
  content: string,
  span: Span | undefined,
  locator: Record<string, unknown>,
): Promise<number | null> {
  if (!span || span.end <= span.start) return null;
  const [row] = await tx
    .insert(evidenceSpans)
    .values({
      documentRevisionId: revisionId,
      startOffset: span.start,
      endOffset: span.end,
      quote: content.slice(span.start, span.end),
      locator,
    })
    .onConflictDoUpdate({
      target: [
        evidenceSpans.documentRevisionId,
        evidenceSpans.startOffset,
        evidenceSpans.endOffset,
      ],
      set: { quote: sql`excluded.quote` },
    })
    .returning({ id: evidenceSpans.id });
  return row?.id ?? null;
}

export async function upsertEdge(tx: Tx, e: EdgeInput): Promise<EdgeOutcome | null> {
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
    politicalRoleId: e.fact.politicalRoleId ?? null,
    affidavitInterestId: e.fact.affidavitInterestId ?? null,
    donationId: e.fact.donationId ?? null,
    policyEventTagId: e.fact.policyEventTagId ?? null,
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

export async function recordEvent(
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
      inputHash: eventInputHash(key),
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

export async function touchCoverage(
  db: Pick<Tx, "insert">,
  companyId: number,
  set: Partial<
    Pick<
      typeof influenceCoverage.$inferInsert,
      | "governanceReadAt"
      | "rptReadAt"
      | "perimeterReadAt"
      | "affidavitsRead"
      | "bondsReadAt"
      | "policyReadAt"
    >
  >,
) {
  const values = { ...set, resolverVersion: INFLUENCE_RESOLVER_VERSION, updatedAt: new Date() };
  await db
    .insert(influenceCoverage)
    .values({ companyId, ...values })
    .onConflictDoUpdate({ target: influenceCoverage.companyId, set: values });
}

export interface Extraction {
  documentRevisionId: number;
  companyId: number | null;
  family: InfluenceFamily;
  version: number;
  inputHash: string;
}

const EXTRACTION_TARGET = [
  influenceExtractions.documentRevisionId,
  influenceExtractions.family,
  influenceExtractions.version,
  influenceExtractions.inputHash,
];

const extractionKey = (x: Extraction) =>
  and(
    eq(influenceExtractions.documentRevisionId, x.documentRevisionId),
    eq(influenceExtractions.family, x.family),
    eq(influenceExtractions.version, x.version),
    eq(influenceExtractions.inputHash, x.inputHash),
  );

export async function alreadyExtracted(ctx: IngestContext, x: Extraction): Promise<boolean> {
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
      target: EXTRACTION_TARGET,
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
      target: EXTRACTION_TARGET,
      set: { status: "failed", error, finishedAt: new Date() },
    });
}

export async function runExtraction<T>(
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

export async function personCandidates(
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

export async function addAlias(tx: Tx, personId: number, alias: string, source: string) {
  await tx
    .insert(personAliases)
    .values({ personId, alias, normalizedAlias: normalizePersonName(alias), source })
    .onConflictDoNothing();
}

export async function listedCompanyIndex(ctx: IngestContext): Promise<Map<string, number>> {
  const rows = await ctx.db.select({ id: companies.id, name: companies.name }).from(companies);
  const out = new Map<string, number>();
  for (const r of rows) {
    const key = normalizeCompanyName(r.name);
    if (key) out.set(key, r.id);
  }
  return out;
}

export async function allPersonCandidates(tx: Tx): Promise<PersonCandidate[]> {
  const [rows, aliases, identifiers] = await Promise.all([
    tx
      .select({ id: persons.id, din: persons.din, normalizedName: persons.normalizedName })
      .from(persons),
    tx
      .select({ personId: personAliases.personId, alias: personAliases.normalizedAlias })
      .from(personAliases),
    tx
      .select({
        personId: personIdentifiers.personId,
        scheme: personIdentifiers.scheme,
        value: personIdentifiers.value,
      })
      .from(personIdentifiers),
  ]);
  const aliasesOf = new Map<number, string[]>();
  for (const a of aliases)
    aliasesOf.set(a.personId, [...(aliasesOf.get(a.personId) ?? []), a.alias]);
  const idsOf = new Map<number, PersonCandidate["identifiers"]>();
  for (const i of identifiers) {
    idsOf.set(i.personId, [...(idsOf.get(i.personId) ?? []), { scheme: i.scheme, value: i.value }]);
  }
  return rows.map((r) => ({
    ...r,
    aliases: aliasesOf.get(r.id) ?? [],
    identifiers: idsOf.get(r.id) ?? [],
  }));
}
