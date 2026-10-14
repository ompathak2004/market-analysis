import { isoDate, sha256, throwIfAborted } from "@ma/core";
import {
  and,
  companies,
  companyPolicySectors,
  eq,
  fencedTransaction,
  graphNodes,
  inArray,
  influenceEdges,
  isNull,
  policyEvents,
  policyEventTags,
  policySectors,
  sql,
  type Tx,
} from "@ma/db";
import {
  EGAZETTE_PARSER_VERSION,
  EgazetteSource,
  type IngestContext,
  lineSnapshot,
  normalizeCompanyName,
  PIB_PARSER_VERSION,
  type PibItem,
  PibSource,
  POLICY_SECTOR_MAP_VERSION,
  POLICY_SECTORS,
  type PolicyDocument,
  type PolicySource,
  PRS_PARSER_VERSION,
  type PrsListing,
  PrsSource,
  policySnapshot,
  readLineSnapshot,
  type SnapshotLine,
  sectorsForIndustry,
} from "@ma/ingest";
import type { LlmClient } from "@ma/llm";
import { policyInputHash } from "./events.js";
import {
  escapeRegex,
  llmTags,
  POLICY_TAGGER_VERSION,
  type PolicyCompany,
  type PolicyTagClaim,
  type PolicyText,
  ruleTags,
  tagTargetKey,
} from "./policy.js";
import { CONFIDENCE, INFLUENCE_RESOLVER_VERSION } from "./resolve.js";
import { edgeStatus, INFLUENCE_EVENT_RULE_VERSION } from "./rules.js";
import {
  alreadyExtracted,
  type Extraction,
  nodeFor,
  nodeOf,
  recordEvent,
  runExtraction,
  spanFor,
  touchCoverage,
  upsertEdge,
} from "./store.js";

const PRS_REFRESH = 10;
const SECTOR_SOURCE = "nse_industry";
const SOURCE_LABEL: Readonly<Record<PolicySource, string>> = {
  pib: "PIB",
  egazette: "Gazette",
  prs: "PRS",
};

export interface PibSourceLike {
  recent(signal?: AbortSignal): Promise<PibItem[]>;
  release(prid: string, signal?: AbortSignal): Promise<PolicyDocument>;
}

export interface PrsSourceLike {
  bills(signal?: AbortSignal): Promise<PrsListing[]>;
  bill(slug: string, signal?: AbortSignal): Promise<PolicyDocument>;
}

export interface GazetteSourceLike {
  notification(url: string, signal?: AbortSignal): Promise<PolicyDocument>;
}

export interface PolicySyncResult {
  listed: number;
  fetched: number;
  created: number;
  updated: number;
  unchanged: number;
  failed: number;
}

export type PolicyTagStatus = "tagged" | "unchanged" | "missing";

export interface PolicyTagResult {
  status: PolicyTagStatus;
  tags: number;
  llmTags: number;
  edges: number;
  events: number;
  tokens: number;
}

export interface SectorSeedResult {
  companies: number;
  rows: number;
  edges: number;
}

const PARSER_VERSION: Readonly<Record<PolicySource, number>> = {
  pib: PIB_PARSER_VERSION,
  egazette: EGAZETTE_PARSER_VERSION,
  prs: PRS_PARSER_VERSION,
};

export async function syncPolicyDocuments(
  ctx: IngestContext,
  docs: readonly PolicyDocument[],
  signal?: AbortSignal,
): Promise<Omit<PolicySyncResult, "listed" | "failed">> {
  const out = { fetched: docs.length, created: 0, updated: 0, unchanged: 0 };
  for (const doc of docs) {
    throwIfAborted(signal);
    const version = PARSER_VERSION[doc.source];
    const snap = policySnapshot(doc, version);
    const { revision } = await ctx.docs.putInline(doc.url, snap.content, {
      source: doc.source,
      publishedAt: doc.publishedAt,
      contentType: "application/json",
      ...(signal ? { signal } : {}),
    });
    const fields = {
      title: doc.title,
      ministry: doc.ministry,
      stage: doc.stage,
      publishedAt: doc.publishedAt,
      url: doc.url,
      documentRevisionId: revision.id,
      inputHash: policyInputHash(doc, version),
    };
    const [row] = await ctx.db
      .insert(policyEvents)
      .values({ source: doc.source, externalId: doc.externalId, ...fields })
      .onConflictDoUpdate({
        target: [policyEvents.source, policyEvents.externalId],
        set: { ...fields, updatedAt: new Date() },
        setWhere: sql`${policyEvents.inputHash} <> excluded.input_hash`,
      })
      .returning({ inserted: sql<boolean>`(xmax = 0)` });
    if (!row) out.unchanged += 1;
    else if (row.inserted) out.created += 1;
    else out.updated += 1;
  }
  return out;
}

async function fetchAll<T>(
  items: readonly T[],
  fetch: (item: T) => Promise<PolicyDocument>,
): Promise<{ docs: PolicyDocument[]; failed: number; error: unknown }> {
  const docs: PolicyDocument[] = [];
  let failed = 0;
  let error: unknown = null;
  for (const item of items) {
    try {
      docs.push(await fetch(item));
    } catch (err) {
      failed += 1;
      error = err;
    }
  }
  if (items.length && !docs.length) throw error;
  return { docs, failed, error };
}

async function knownIds(ctx: IngestContext, source: PolicySource, ids: readonly string[]) {
  if (!ids.length) return [];
  return ctx.db
    .select({ externalId: policyEvents.externalId, updatedAt: policyEvents.updatedAt })
    .from(policyEvents)
    .where(and(eq(policyEvents.source, source), inArray(policyEvents.externalId, [...ids])));
}

export async function syncPib(
  ctx: IngestContext,
  opts: { signal?: AbortSignal; source?: PibSourceLike } = {},
): Promise<PolicySyncResult> {
  const { signal } = opts;
  const source = opts.source ?? new PibSource(ctx.http);
  const items = await source.recent(signal);
  const known = new Set(
    (
      await knownIds(
        ctx,
        "pib",
        items.map((i) => i.prid),
      )
    ).map((k) => k.externalId),
  );
  const fresh = items.filter((i) => !known.has(i.prid));
  const { docs, failed } = await fetchAll(fresh, (i) => source.release(i.prid, signal));
  const out = await syncPolicyDocuments(ctx, docs, signal);
  return { listed: items.length, failed, ...out };
}

export async function syncPrs(
  ctx: IngestContext,
  opts: { signal?: AbortSignal; source?: PrsSourceLike; refresh?: number } = {},
): Promise<PolicySyncResult> {
  const { signal } = opts;
  const source = opts.source ?? new PrsSource(ctx.http);
  const bills = await source.bills(signal);
  const known = await knownIds(
    ctx,
    "prs",
    bills.map((b) => b.slug),
  );
  const seen = new Set(known.map((k) => k.externalId));
  const stale = [...known]
    .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime())
    .slice(0, opts.refresh ?? PRS_REFRESH)
    .map((k) => k.externalId);
  const targets = [...bills.filter((b) => !seen.has(b.slug)).map((b) => b.slug), ...stale];
  const { docs, failed } = await fetchAll(targets, (slug) => source.bill(slug, signal));
  const out = await syncPolicyDocuments(ctx, docs, signal);
  return { listed: bills.length, failed, ...out };
}

export async function syncGazette(
  ctx: IngestContext,
  urls: readonly string[],
  opts: { signal?: AbortSignal; source?: GazetteSourceLike } = {},
): Promise<PolicySyncResult> {
  const { signal } = opts;
  const source = opts.source ?? new EgazetteSource(ctx.http);
  const { docs, failed } = await fetchAll(urls, (url) => source.notification(url, signal));
  const out = await syncPolicyDocuments(ctx, docs, signal);
  return { listed: urls.length, failed, ...out };
}

export async function untaggedPolicyEvents(ctx: IngestContext, limit: number): Promise<number[]> {
  const rows = await ctx.db
    .select({ id: policyEvents.id })
    .from(policyEvents)
    .where(
      sql`${policyEvents.documentRevisionId} is not null and not exists (
        select 1 from influence_extractions x
        where x.document_revision_id = ${policyEvents.documentRevisionId}
          and x.family::text = ${policyEvents.source}::text
          and x.version = ${POLICY_TAGGER_VERSION}
          and x.status = 'succeeded')`,
    )
    .orderBy(sql`${policyEvents.publishedAt} desc`)
    .limit(limit);
  return rows.map((r) => r.id);
}

async function seedSectors(tx: Pick<Tx, "insert">) {
  await tx
    .insert(policySectors)
    .values(
      POLICY_SECTORS.map((s) => ({
        key: s.key,
        label: s.label,
        ministryKeys: [...s.ministryKeys],
      })),
    )
    .onConflictDoUpdate({
      target: policySectors.key,
      set: { label: sql`excluded.label`, ministryKeys: sql`excluded.ministry_keys` },
    });
}

export const nseQuoteUrl = (symbol: string) =>
  `https://www.nseindia.com/get-quotes/equity?symbol=${encodeURIComponent(symbol)}`;

async function closeStaleSectors(
  tx: Tx,
  companyId: number,
  companyNode: number,
  keep: number[],
  keepKeys: string[],
) {
  await tx
    .update(influenceEdges)
    .set({ validTo: isoDate(new Date()), updatedAt: new Date() })
    .where(
      and(
        eq(influenceEdges.fromNodeId, companyNode),
        eq(influenceEdges.kind, "operates_in_sector"),
        inArray(influenceEdges.status, ["confirmed", "pending"]),
        isNull(influenceEdges.validTo),
        keep.length ? sql`not (${inArray(influenceEdges.toNodeId, keep)})` : sql`true`,
      ),
    );
  await tx
    .delete(companyPolicySectors)
    .where(
      and(
        eq(companyPolicySectors.companyId, companyId),
        eq(companyPolicySectors.source, SECTOR_SOURCE),
        keepKeys.length
          ? sql`not (${inArray(companyPolicySectors.sectorKey, keepKeys)})`
          : sql`true`,
      ),
    );
}

export async function seedCompanyPolicySectors(
  ctx: IngestContext,
  signal?: AbortSignal,
): Promise<SectorSeedResult> {
  await fencedTransaction(ctx.db, (tx) => seedSectors(tx), signal);
  const rows = await ctx.db
    .select({
      id: companies.id,
      symbol: companies.nseSymbol,
      name: companies.name,
      industry: companies.industry,
    })
    .from(companies);
  const out: SectorSeedResult = { companies: 0, rows: 0, edges: 0 };
  for (const c of rows) {
    throwIfAborted(signal);
    const keys = c.symbol ? sectorsForIndustry(c.industry) : [];
    if (!c.symbol || !keys.length) {
      await fencedTransaction(
        ctx.db,
        async (tx) => {
          const [node] = await tx
            .select({ id: graphNodes.id })
            .from(graphNodes)
            .where(eq(graphNodes.companyId, c.id));
          if (node) await closeStaleSectors(tx, c.id, node.id, [], []);
        },
        signal,
      );
      continue;
    }
    const symbol = c.symbol;
    const snap = lineSnapshot(
      { source: SECTOR_SOURCE, symbol },
      [c],
      () => `company:${symbol}`,
      () => ({ name: c.name, industry: c.industry }),
    );
    const { revision } = await ctx.docs.putInline(nseQuoteUrl(symbol), snap.content, {
      source: SECTOR_SOURCE,
      companyId: c.id,
      contentType: "application/json",
      ...(signal ? { signal } : {}),
    });
    out.companies += 1;
    await fencedTransaction(
      ctx.db,
      async (tx) => {
        const spanId = await spanFor(
          tx,
          revision.id,
          snap.content,
          snap.spans.get(`company:${symbol}`),
          {
            kind: "industry",
            field: "industry",
          },
        );
        const companyNode = await nodeFor(tx, "company", c.id);
        const sectorNodes: number[] = [];
        for (const sectorKey of keys) {
          sectorNodes.push(await nodeOf(tx, { kind: "policy_sector", sectorKey }));
        }
        await closeStaleSectors(tx, c.id, companyNode, sectorNodes, keys);
        const inserted = await tx
          .insert(companyPolicySectors)
          .values(
            keys.map((sectorKey) => ({
              companyId: c.id,
              sectorKey,
              source: SECTOR_SOURCE,
              evidenceSpanId: spanId,
            })),
          )
          .onConflictDoUpdate({
            target: [companyPolicySectors.companyId, companyPolicySectors.sectorKey],
            set: { source: SECTOR_SOURCE, evidenceSpanId: spanId },
            setWhere: sql`(${companyPolicySectors.source}, ${companyPolicySectors.evidenceSpanId})
            is distinct from (excluded.source, excluded.evidence_span_id)`,
          })
          .returning({ key: companyPolicySectors.sectorKey });
        out.rows += inserted.length;
        for (const [i, sectorKey] of keys.entries()) {
          const toNodeId = sectorNodes[i];
          if (toNodeId === undefined) continue;
          const edge = await upsertEdge(tx, {
            fromNodeId: companyNode,
            toNodeId,
            kind: "operates_in_sector",
            fact: {},
            confidence: CONFIDENCE.twoPrimaryDocuments,
            source: "structured_primary",
            identifier: true,
            inputHash: sha256(
              JSON.stringify([revision.contentSha256, sectorKey, POLICY_SECTOR_MAP_VERSION]),
            ),
            validFrom: null,
            validTo: null,
            spanIds: spanId ? [spanId] : [],
          });
          if (edge?.changed) out.edges += 1;
        }
      },
      signal,
    );
  }
  return out;
}

export function quoteSpan(
  content: string,
  line: SnapshotLine | undefined,
  field: PolicyTagClaim["field"],
  quote: string,
): { start: number; end: number } | undefined {
  if (!line) return undefined;
  if (field === "ministry") return { start: line.start, end: line.end };
  const words = quote.split(/\s+/).filter(Boolean);
  if (!words.length) return undefined;
  const re = new RegExp(
    words.map((w) => escapeRegex(JSON.stringify(w).slice(1, -1))).join("(?:\\s|\\\\[nrt])+"),
  );
  const hit = re.exec(content.slice(line.start, line.end));
  return hit
    ? { start: line.start + hit.index, end: line.start + hit.index + hit[0].length }
    : undefined;
}

const lineValue = (lines: ReadonlyMap<string, SnapshotLine>, key: string): string | null => {
  const v = lines.get(key)?.row.value;
  return typeof v === "string" ? v : null;
};

export async function tagPolicyEvent(
  ctx: IngestContext,
  policyEventId: number,
  opts: { signal?: AbortSignal; llm?: Pick<LlmClient, "complete"> | null } = {},
): Promise<PolicyTagResult> {
  const { signal } = opts;
  const empty: PolicyTagResult = {
    status: "missing",
    tags: 0,
    llmTags: 0,
    edges: 0,
    events: 0,
    tokens: 0,
  };
  const [ev] = await ctx.db.select().from(policyEvents).where(eq(policyEvents.id, policyEventId));
  if (!ev?.documentRevisionId) return empty;
  const revision = await ctx.docs.revision(ev.documentRevisionId);
  if (!revision) return empty;
  const extraction: Extraction = {
    documentRevisionId: revision.id,
    companyId: null,
    family: ev.source,
    version: POLICY_TAGGER_VERSION,
    inputHash: sha256(
      [
        ev.inputHash,
        POLICY_TAGGER_VERSION,
        POLICY_SECTOR_MAP_VERSION,
        INFLUENCE_RESOLVER_VERSION,
        INFLUENCE_EVENT_RULE_VERSION,
      ].join(":"),
    ),
  };
  if (await alreadyExtracted(ctx, extraction)) return { ...empty, status: "unchanged" };
  const content = await ctx.docs.text(revision);
  const lines = readLineSnapshot(content);
  const doc: PolicyText = {
    title: lineValue(lines, "title") ?? ev.title,
    ministry: lineValue(lines, "ministry"),
    text: lineValue(lines, "text") ?? "",
  };
  const listed: PolicyCompany[] = (
    await ctx.db.select({ id: companies.id, name: companies.name }).from(companies)
  ).map((c) => ({ id: c.id, normalizedName: normalizeCompanyName(c.name) }));
  const rules = ruleTags(doc, listed);
  const ruleSectors = new Set(
    rules.flatMap((t) => ("sectorKey" in t.target ? [t.target.sectorKey] : [])),
  );
  const inferred =
    opts.llm && !ruleSectors.size && doc.text
      ? await llmTags(opts.llm, doc, ruleSectors)
      : { tags: [], tokens: 0 };
  throwIfAborted(signal);
  const claims = [...rules, ...inferred.tags];

  const out = await runExtraction(ctx, extraction, signal, async (tx) => {
    await seedSectors(tx);
    const eventNode = await nodeOf(tx, { kind: "policy_event", policyEventId: ev.id });
    const affected = new Map<number, number[]>();
    let edges = 0;
    for (const claim of claims) {
      const spanId = await spanFor(
        tx,
        revision.id,
        content,
        quoteSpan(content, lines.get(claim.field), claim.field, claim.quote),
        { kind: "policy_tag", field: claim.field, basis: claim.basis },
      );
      const target = claim.target;
      const [tag] = await tx
        .insert(policyEventTags)
        .values({
          policyEventId: ev.id,
          ...("sectorKey" in target
            ? { sectorKey: target.sectorKey }
            : { companyId: target.companyId }),
          basis: claim.basis,
          evidenceSpanId: spanId,
          confidence: claim.confidence,
        })
        .onConflictDoUpdate({
          target: [
            policyEventTags.policyEventId,
            policyEventTags.sectorKey,
            policyEventTags.companyId,
          ],
          set: { basis: claim.basis, evidenceSpanId: spanId, confidence: claim.confidence },
        })
        .returning({ id: policyEventTags.id });
      if (!tag) throw new Error(`policy tag upsert failed for ${tagTargetKey(target)}`);
      const edge = await upsertEdge(tx, {
        fromNodeId: eventNode,
        toNodeId:
          "sectorKey" in target
            ? await nodeOf(tx, { kind: "policy_sector", sectorKey: target.sectorKey })
            : await nodeFor(tx, "company", target.companyId),
        kind: "policy_applies_to",
        fact: { policyEventTagId: tag.id },
        confidence: claim.confidence,
        source: claim.source,
        identifier: claim.identifier,
        inputHash: sha256(
          JSON.stringify([claim.basis, tagTargetKey(target), claim.quote, ev.inputHash]),
        ),
        validFrom: isoDate(ev.publishedAt),
        validTo: null,
        spanIds: spanId ? [spanId] : [],
      });
      if (edge?.changed) edges += 1;
      if (!edge || edgeStatus(claim) !== "confirmed") continue;
      const companyIds =
        "sectorKey" in target
          ? (
              await tx
                .select({ id: companyPolicySectors.companyId })
                .from(companyPolicySectors)
                .where(eq(companyPolicySectors.sectorKey, target.sectorKey))
            ).map((r) => r.id)
          : [target.companyId];
      for (const id of companyIds) affected.set(id, [...(affected.get(id) ?? []), edge.id]);
    }
    let events = 0;
    const label = SOURCE_LABEL[ev.source];
    for (const [companyId, edgeIds] of affected) {
      const recorded = await recordEvent(
        tx,
        companyId,
        "policy_change",
        ev.publishedAt,
        `${label}: ${ev.title}${ev.stage ? ` (${ev.stage})` : ""}`,
        [ev.id, ev.inputHash],
        edgeIds,
      );
      if (recorded) events += 1;
      await touchCoverage(tx, companyId, { policyReadAt: new Date() });
    }
    return { rows: claims.length, edges, events };
  });
  return {
    status: "tagged",
    tags: out.rows,
    llmTags: inferred.tags.length,
    edges: out.edges,
    events: out.events,
    tokens: inferred.tokens,
  };
}
