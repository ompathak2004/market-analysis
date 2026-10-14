import { DAY, DeadlineExceededError, isoDate, remainingMs, throwIfAborted } from "@ma/core";
import { companies, eq, fencedTransaction, signals, sql, type Tx } from "@ma/db";
import type { IngestContext } from "../context.js";
import type { FetchDocumentResult } from "../documents.js";
import {
  type AliasEntry,
  type AliasMatcher,
  extractConcentration,
  extractObservations,
  extractTopCustomerShares,
  type Period,
  RELATIONSHIP_EXTRACTOR_VERSION,
  toCrore,
} from "../extract/relationships.js";
import { fiscalPeriod, looksLikeMarkup, maskMarkup } from "../extract/text.js";
import { loadCounterpartyMatcher, syncCounterparties } from "../relationships/counterparties.js";
import {
  type ExtractionUnit,
  inputsHash,
  markSourceRead,
  matcherFingerprint,
  nextGraphRevision,
  noteSourceError,
  recordExtractionFailure,
  refreshGraphState,
  registerSource,
  succeededExtraction,
  writeExtraction,
} from "../relationships/graph.js";
import { screenerUrl } from "../sources/screener.js";

export type DocumentFamily = "annual_report" | "concall" | "screener";
export const DOCUMENT_FAMILIES: readonly DocumentFamily[] = [
  "annual_report",
  "concall",
  "screener",
];

const DOCUMENT_MS = 30_000;
const DISCOVERED_MAX_AGE_MS = 365 * DAY;
const STORED_MAX_AGE_MS = 10 * 365 * DAY;
const SCREENER_MAX_AGE_MS = 7 * DAY;

export interface RelationshipSource {
  label: string | null;
  url: string;
  kind: DocumentFamily;
}

export interface RelationshipExtractionResult {
  documents: number;
  skipped: number;
  failed: number;
  remaining: number;
  observations: number;
  dropped: number;
  relationships: number;
  concentration: number | null;
}

export async function loadAliasMatcher(ctx: Pick<IngestContext, "db">): Promise<AliasMatcher> {
  return loadCounterpartyMatcher(ctx.db);
}

export async function relationshipSourcesFor(
  ctx: IngestContext,
  companyId: number,
  discovered: readonly RelationshipSource[],
  force: boolean,
): Promise<Array<RelationshipSource & { stored: boolean }>> {
  const stored = await ctx.db.execute<{
    url: string;
    family: DocumentFamily;
    label: string | null;
  }>(
    force
      ? sql`
        select d.url, d.source as family, rs.label
        from documents d
        left join relationship_sources rs on rs.document_id = d.id and rs.company_id = ${companyId}
          and rs.family::text = d.source
        where d.source in ('annual_report', 'concall', 'screener')
          and (d.company_id = ${companyId} or d.id in (
            select r.source_document_id from relationships r
            where r.status = 'legacy' and r.source_document_id is not null
              and (r.supplier_company_id = ${companyId} or r.customer_company_id = ${companyId})))`
      : sql`
        select d.url, rs.family::text as family, rs.label
        from relationship_sources rs
        join documents d on d.id = rs.document_id
        where rs.company_id = ${companyId}
          and rs.family in ('annual_report', 'concall', 'screener')
          and (rs.read_revision_id is null
            or rs.read_revision_id is distinct from d.current_revision_id
            or coalesce(rs.read_extractor_version, 0) < ${RELATIONSHIP_EXTRACTOR_VERSION})`,
  );
  const out = new Map<string, RelationshipSource & { stored: boolean }>();
  for (const s of discovered) out.set(s.url, { ...s, stored: false });
  for (const s of stored) {
    if (!out.has(s.url)) {
      out.set(s.url, { label: s.label, url: s.url, kind: s.family, stored: true });
    }
  }
  return [...out.values()];
}

export async function extractRelationshipsForCompany(
  ctx: IngestContext,
  companyId: number,
  sources: ReadonlyArray<RelationshipSource>,
  matcher: AliasMatcher,
  signal?: AbortSignal,
  opts: { force?: boolean } = {},
): Promise<RelationshipExtractionResult> {
  const company = await ctx.db.query.companies.findFirst({ where: eq(companies.id, companyId) });
  if (!company) throw new Error(`company ${companyId} not found`);
  let aliases = matcher;
  let focal = aliases.byCompany.get(companyId) ?? null;
  if (!focal) {
    await syncCounterparties(ctx.db, signal);
    aliases = await loadAliasMatcher(ctx);
    focal = aliases.byCompany.get(companyId) ?? null;
  }
  if (!focal) throw new Error(`company ${companyId} has no counterparty`);

  const fingerprint = matcherFingerprint(aliases);
  const graphRevision = await nextGraphRevision(ctx.db, companyId);
  const discovered: RelationshipSource[] = company.screenerSlug
    ? [...sources, { label: null, url: screenerUrl(company.screenerSlug), kind: "screener" }]
    : [...sources];
  const queue = await relationshipSourcesFor(ctx, companyId, discovered, opts.force ?? false);
  const result: RelationshipExtractionResult = {
    documents: 0,
    skipped: 0,
    failed: 0,
    remaining: 0,
    observations: 0,
    dropped: 0,
    relationships: 0,
    concentration: null,
  };

  for (const [i, src] of queue.entries()) {
    throwIfAborted(signal);
    if (remainingMs() < DOCUMENT_MS) {
      result.remaining = queue.length - i;
      break;
    }
    let fetched: FetchDocumentResult;
    try {
      fetched = await ctx.docs.fetch(src.url, {
        source: src.kind,
        companyId,
        maxAgeMs:
          src.kind === "screener"
            ? SCREENER_MAX_AGE_MS
            : src.stored
              ? STORED_MAX_AGE_MS
              : DISCOVERED_MAX_AGE_MS,
        publishedAt: publishedFromLabel(src),
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      if (err instanceof DeadlineExceededError) throw err;
      throwIfAborted(signal);
      ctx.logger.warn({ err, url: src.url }, "relationship document fetch failed");
      await noteSourceError(ctx.db, companyId, src.kind, src.url, err);
      result.failed++;
      continue;
    }
    const outcome = await readDocument(ctx, companyId, focal, aliases, src, fetched, {
      fingerprint,
      graphRevision,
      force: opts.force ?? false,
      ...(signal ? { signal } : {}),
    });
    if (outcome === "skipped") result.skipped++;
    else if (outcome === "failed") result.failed++;
    else {
      result.documents++;
      result.observations += outcome.observations;
      result.dropped += outcome.dropped;
      result.relationships += outcome.edges;
      if (outcome.concentration !== null) result.concentration = outcome.concentration;
    }
  }

  await refreshGraphState(ctx.db, companyId, graphRevision, RELATIONSHIP_EXTRACTOR_VERSION);
  ctx.logger.info({ companyId, ...result }, "relationships extracted");
  return result;
}

interface ReadOptions {
  fingerprint: string;
  graphRevision: number;
  force: boolean;
  signal?: AbortSignal;
}

type ReadOutcome =
  | "skipped"
  | "failed"
  | { observations: number; dropped: number; edges: number; concentration: number | null };

async function readDocument(
  ctx: IngestContext,
  companyId: number,
  focal: AliasEntry,
  matcher: AliasMatcher,
  src: RelationshipSource,
  fetched: FetchDocumentResult,
  opts: ReadOptions,
): Promise<ReadOutcome> {
  const { doc, revision } = fetched;
  const published = publishedFromLabel(src);
  const registered = await registerSource(ctx.db, {
    companyId,
    family: src.kind,
    documentId: doc.id,
    label: src.label,
    publishedAt: published ? isoDate(published) : null,
  });
  if (
    !opts.force &&
    registered.readRevisionId === revision.id &&
    registered.readExtractorVersion === RELATIONSHIP_EXTRACTOR_VERSION
  ) {
    return "skipped";
  }
  const unit: ExtractionUnit = {
    companyId,
    family: src.kind,
    extractorVersion: RELATIONSHIP_EXTRACTOR_VERSION,
    inputsHash: inputsHash(
      revision.contentSha256,
      RELATIONSHIP_EXTRACTOR_VERSION,
      opts.fingerprint,
    ),
    documentId: doc.id,
    revisionId: revision.id,
    pageMap: revision.pageMap,
    graphRevision: opts.graphRevision,
  };
  if (await succeededExtraction(ctx.db, unit)) {
    await markSourceRead(ctx.db, unit);
    return "skipped";
  }
  try {
    const text = looksLikeMarkup(fetched.text, doc.contentType)
      ? maskMarkup(fetched.text)
      : fetched.text;
    const found = extractObservations(text, matcher, {
      focal,
      family: src.kind,
      period: periodOf(src),
    });
    return await fencedTransaction(
      ctx.db,
      async (tx) => {
        const concentration =
          src.kind === "screener" ? null : await writeSignals(tx, companyId, src, text, doc.id);
        const written = await writeExtraction(tx, unit, found);
        await refreshGraphState(tx, companyId, opts.graphRevision, RELATIONSHIP_EXTRACTOR_VERSION);
        return {
          observations: written.observations,
          dropped: written.dropped,
          edges: written.edges,
          concentration,
        };
      },
      opts.signal,
    );
  } catch (err) {
    const deferred = err instanceof DeadlineExceededError || opts.signal?.aborted === true;
    const message = err instanceof Error ? err.message : String(err);
    await recordExtractionFailure(ctx.db, unit, deferred ? "deferred" : "failed", message);
    if (deferred) throw err;
    await noteSourceError(ctx.db, companyId, src.kind, src.url, err);
    ctx.logger.warn({ err, companyId, documentId: doc.id }, "relationship extraction failed");
    return "failed";
  }
}

async function writeSignals(
  tx: Tx,
  companyId: number,
  src: RelationshipSource,
  text: string,
  documentId: number,
): Promise<number | null> {
  const fyEnd = periodEndFromLabel(src.label ?? "");
  let concentration: number | null = null;
  if (src.kind === "annual_report") {
    const c = extractConcentration(text);
    if (c?.revenueFromThem != null) {
      const revenueCr = toCrore(c.revenueFromThem, c.unit);
      const fy = await tx.query.fundamentals.findFirst({
        where: (f, { and, eq }) =>
          and(eq(f.companyId, companyId), eq(f.periodEnd, fyEnd), eq(f.periodType, "annual")),
      });
      const total = fy?.revenue ? Number(fy.revenue) : null;
      if (total && total > 0) {
        concentration = Math.min(100, (revenueCr / total) * 100);
        await upsertSignal(tx, companyId, fyEnd, "customer_concentration_pct", concentration, {
          customersOver10Pct: c.customersOver10Pct,
          revenueFromThemCr: revenueCr,
          totalRevenueCr: total,
          documentId,
        });
      }
    }
  }
  for (const share of extractTopCustomerShares(text).slice(0, 3)) {
    await upsertSignal(tx, companyId, fyEnd, `top${share.topN}_customers_pct`, share.pct, {
      sentence: share.sentence,
      documentId,
    });
  }
  return concentration;
}

async function upsertSignal(
  db: Tx,
  companyId: number,
  asOf: string,
  kind: string,
  value: number,
  inputs: Record<string, unknown>,
): Promise<void> {
  await db
    .insert(signals)
    .values({ companyId, asOf, kind, value, inputs, modelVersion: RELATIONSHIP_EXTRACTOR_VERSION })
    .onConflictDoUpdate({
      target: [signals.companyId, signals.asOf, signals.kind, signals.modelVersion],
      set: { value: sql`excluded.value`, inputs: sql`excluded.inputs` },
    });
}

function periodOf(src: RelationshipSource): Period {
  if (src.kind === "annual_report" && src.label) {
    const fy = fiscalYearFromLabel(src.label);
    if (fy !== null) return { ...fiscalPeriod(fy), fiscalYear: fy };
  }
  if (src.kind === "concall" && src.label) {
    const end = monthEndFromLabel(src.label);
    if (end !== null) return { start: null, end, fiscalYear: null };
  }
  return { start: null, end: null, fiscalYear: null };
}

function publishedFromLabel(src: RelationshipSource): Date | null {
  if (!src.label || src.kind === "screener") return null;
  const end =
    monthEndFromLabel(src.label) ??
    (fiscalYearFromLabel(src.label) === null ? null : periodEndFromLabel(src.label));
  return end === null ? null : new Date(`${end}T00:00:00Z`);
}

export function fiscalYearFromLabel(label: string): number | null {
  const fy = /\b(?:FY\s?'?(\d{2,4})|(20\d{2}))\b/i.exec(label);
  if (!fy) return null;
  const n = Number(fy[1] ?? fy[2]);
  return n < 100 ? 2000 + n : n;
}

function monthEndFromLabel(label: string): string | null {
  const m = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+(20\d{2})\b/i.exec(label);
  if (!m) return null;
  const month = MONTHS.indexOf((m[1] as string).slice(0, 3).toLowerCase()) + 1;
  return isoDate(new Date(Date.UTC(Number(m[2]), month, 0)));
}

export function periodEndFromLabel(label: string): string {
  const month = monthEndFromLabel(label);
  if (month) return month;
  const fy = fiscalYearFromLabel(label);
  return fy ? `${fy}-03-31` : isoDate(new Date());
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
