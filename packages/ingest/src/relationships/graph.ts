import { addYears, isoDate, sha256 } from "@ma/core";
import {
  and,
  companyGraphState,
  counterparties,
  eq,
  evidenceSpans,
  inArray,
  type PageSpan,
  relationshipExtractions,
  relationshipObservationEvidence,
  relationshipObservations,
  relationshipSources,
  relationships,
  sql,
  type Tx,
} from "@ma/db";
import { pageOf } from "../documents.js";
import {
  ALIAS_RESOLVER_VERSION,
  type AliasMatcher,
  type CostBucket,
  type Observation,
  type SourceFamily,
  type ValueBasis,
} from "../extract/relationships.js";

export const AUTO_CONFIDENCE = 0.8;
export const EDGE_LIFETIME_YEARS = 4;
const QUOTE_MAX = 2000;
const EVIDENCE_MAX = 1000;
const LIVE = ["pending", "auto", "confirmed"] as const;
const REVIEWED = ["confirmed", "rejected", "blocked"] as const;

export function edgeKey(supplier: number, customer: number, bucket: CostBucket): string {
  return sha256(`${supplier}|${customer}|${bucket}`);
}

export function matcherFingerprint(matcher: AliasMatcher): string {
  const groups = [...matcher.entries.values()]
    .filter((e) => e.groupKeys.length)
    .map((e) => `${e.counterpartyId}:${[...e.groupKeys].sort().join(",")}`)
    .sort();
  return sha256([...[...matcher.blocks].sort(), "#", ...groups].join("\n"));
}

export function inputsHash(
  contentSha256: string,
  extractorVersion: number,
  fingerprint: string,
): string {
  return sha256(`${contentSha256}|${ALIAS_RESOLVER_VERSION}|${extractorVersion}|${fingerprint}`);
}

export interface ExtractionUnit {
  companyId: number;
  family: SourceFamily;
  extractorVersion: number;
  inputsHash: string;
  documentId: number;
  revisionId: number;
  pageMap: readonly PageSpan[] | null;
  graphRevision: number;
}

export interface ExtractionWrite {
  extractionId: number;
  observations: number;
  dropped: number;
  edges: number;
}

export async function succeededExtraction(tx: Pick<Tx, "select">, unit: ExtractionUnit) {
  const [row] = await tx
    .select({ id: relationshipExtractions.id })
    .from(relationshipExtractions)
    .where(
      and(
        eq(relationshipExtractions.documentRevisionId, unit.revisionId),
        eq(relationshipExtractions.extractorFamily, unit.family),
        eq(relationshipExtractions.extractorVersion, unit.extractorVersion),
        eq(relationshipExtractions.inputsHash, unit.inputsHash),
        eq(relationshipExtractions.status, "succeeded"),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function recordExtractionFailure(
  tx: Pick<Tx, "insert">,
  unit: ExtractionUnit,
  status: "failed" | "deferred",
  error: string,
): Promise<void> {
  await tx
    .insert(relationshipExtractions)
    .values({
      documentRevisionId: unit.revisionId,
      companyId: unit.companyId,
      extractorFamily: unit.family,
      extractorVersion: unit.extractorVersion,
      inputsHash: unit.inputsHash,
      status,
      error: error.slice(0, 1000),
      finishedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [
        relationshipExtractions.documentRevisionId,
        relationshipExtractions.extractorFamily,
        relationshipExtractions.extractorVersion,
        relationshipExtractions.inputsHash,
      ],
      set: { status, error: error.slice(0, 1000), finishedAt: new Date() },
      setWhere: sql`${relationshipExtractions.status} <> 'succeeded'`,
    });
}

function claimKey(supplier: number, customer: number, bucket: string, claim: string): string {
  return `${supplier}|${customer}|${bucket}|${claim.replace(/\s+/g, " ").trim().toLowerCase()}`;
}

export async function writeExtraction(
  tx: Tx,
  unit: ExtractionUnit,
  found: { observations: readonly Observation[]; dropped: number },
): Promise<ExtractionWrite> {
  const removed = await tx.execute<{ supplier: number; customer: number }>(sql`
    delete from relationship_observations o
    using relationship_extractions e, document_revisions r
    where o.extraction_id = e.id and e.document_revision_id = r.id
      and r.document_id = ${unit.documentId} and e.extractor_family = ${unit.family}
      and o.focal_company_id = ${unit.companyId} and o.status in ('pending', 'auto')
    returning o.supplier_counterparty_id as supplier, o.customer_counterparty_id as customer`);

  const reviewed = await tx.execute<{
    supplier: number;
    customer: number;
    bucket: string;
    claim: string;
  }>(sql`
    select o.supplier_counterparty_id as supplier, o.customer_counterparty_id as customer,
      o.cost_bucket as bucket, o.claim
    from relationship_observations o
    join relationship_extractions e on e.id = o.extraction_id
    join document_revisions r on r.id = e.document_revision_id
    where r.document_id = ${unit.documentId} and e.extractor_family = ${unit.family}
      and o.focal_company_id = ${unit.companyId}
      and o.status in (${sql.join(
        REVIEWED.map((s) => sql`${s}`),
        sql`, `,
      )})`);
  const seen = new Set(
    reviewed.map((r) => claimKey(Number(r.supplier), Number(r.customer), r.bucket, r.claim)),
  );
  const fresh = found.observations.filter(
    (o) =>
      !seen.has(
        claimKey(o.supplier.counterpartyId, o.customer.counterpartyId, o.costBucket, o.claim),
      ),
  );
  const dropped = found.dropped + found.observations.length - fresh.length;

  const [extraction] = await tx
    .insert(relationshipExtractions)
    .values({
      documentRevisionId: unit.revisionId,
      companyId: unit.companyId,
      extractorFamily: unit.family,
      extractorVersion: unit.extractorVersion,
      inputsHash: unit.inputsHash,
      status: "succeeded",
      observations: fresh.length,
      dropped,
      finishedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [
        relationshipExtractions.documentRevisionId,
        relationshipExtractions.extractorFamily,
        relationshipExtractions.extractorVersion,
        relationshipExtractions.inputsHash,
      ],
      set: {
        status: "succeeded",
        observations: fresh.length,
        dropped,
        error: null,
        startedAt: new Date(),
        finishedAt: new Date(),
      },
    })
    .returning({ id: relationshipExtractions.id });
  if (!extraction) throw new Error("relationship extraction insert failed");

  if (fresh.length) {
    const ranges = new Map<string, Observation>();
    for (const o of fresh) ranges.set(`${o.start}:${o.end}`, o);
    const spans = await tx
      .insert(evidenceSpans)
      .values(
        [...ranges.values()].map((o) => ({
          documentRevisionId: unit.revisionId,
          startOffset: o.start,
          endOffset: o.end,
          quote: o.claim.slice(0, QUOTE_MAX),
          page: pageOf(unit.pageMap, o.start),
          locator: { family: unit.family },
        })),
      )
      .onConflictDoUpdate({
        target: [
          evidenceSpans.documentRevisionId,
          evidenceSpans.startOffset,
          evidenceSpans.endOffset,
        ],
        set: { quote: sql`excluded.quote` },
      })
      .returning({
        id: evidenceSpans.id,
        start: evidenceSpans.startOffset,
        end: evidenceSpans.endOffset,
      });
    const spanOf = new Map(spans.map((s) => [`${s.start}:${s.end}`, s.id]));
    const inserted = await tx
      .insert(relationshipObservations)
      .values(
        fresh.map((o) => ({
          extractionId: extraction.id,
          focalCompanyId: unit.companyId,
          supplierCounterpartyId: o.supplier.counterpartyId,
          customerCounterpartyId: o.customer.counterpartyId,
          disclosedBy: o.disclosedBy,
          disclosureKind: o.disclosureKind,
          costBucket: o.costBucket,
          valueBasis: o.valueBasis,
          cueClass: o.cueClass,
          pct: o.pct,
          valueCr: o.valueCr === null ? null : o.valueCr.toFixed(2),
          currency: o.currency,
          periodStart: o.period.start,
          periodEnd: o.period.end,
          fiscalYear: o.period.fiscalYear,
          orderStatus: o.orderStatus,
          claim: o.claim,
          confidence: o.confidence,
          status:
            o.confidence >= AUTO_CONFIDENCE && !o.newCounterparty
              ? ("auto" as const)
              : ("pending" as const),
          newCounterparty: o.newCounterparty,
        })),
      )
      .returning({ id: relationshipObservations.id });
    await tx.insert(relationshipObservationEvidence).values(
      inserted.map((row, i) => {
        const o = fresh[i] as Observation;
        return {
          observationId: row.id,
          evidenceSpanId: spanOf.get(`${o.start}:${o.end}`) as number,
        };
      }),
    );
  }

  const pairs = new Map<string, readonly [number, number]>();
  for (const r of removed)
    pairs.set(`${r.supplier}|${r.customer}`, [Number(r.supplier), Number(r.customer)]);
  for (const o of fresh) {
    pairs.set(`${o.supplier.counterpartyId}|${o.customer.counterpartyId}`, [
      o.supplier.counterpartyId,
      o.customer.counterpartyId,
    ]);
  }
  const edges = await materializeEdges(tx, [...pairs.values()], unit.graphRevision);
  await markSourceRead(tx, unit);
  return { extractionId: extraction.id, observations: fresh.length, dropped, edges };
}

export interface SourceRegistration {
  companyId: number;
  family: SourceFamily;
  documentId: number;
  label: string | null;
  publishedAt: string | null;
}

export async function registerSource(
  tx: Pick<Tx, "insert">,
  row: SourceRegistration,
): Promise<{ readRevisionId: number | null; readExtractorVersion: number | null }> {
  const [registered] = await tx
    .insert(relationshipSources)
    .values(row)
    .onConflictDoUpdate({
      target: [
        relationshipSources.companyId,
        relationshipSources.family,
        relationshipSources.documentId,
      ],
      set: {
        label: sql`coalesce(excluded.label, ${relationshipSources.label})`,
        publishedAt: sql`coalesce(excluded.published_at, ${relationshipSources.publishedAt})`,
        updatedAt: new Date(),
      },
    })
    .returning({
      readRevisionId: relationshipSources.readRevisionId,
      readExtractorVersion: relationshipSources.readExtractorVersion,
    });
  return {
    readRevisionId: registered?.readRevisionId ?? null,
    readExtractorVersion: registered?.readExtractorVersion ?? null,
  };
}

export async function noteSourceError(
  tx: Pick<Tx, "execute">,
  companyId: number,
  family: SourceFamily,
  url: string,
  err: unknown,
): Promise<void> {
  const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
  await tx.execute(sql`
    update relationship_sources rs set last_error = ${message}, updated_at = now()
    from documents d
    where d.id = rs.document_id and d.url = ${url}
      and rs.company_id = ${companyId} and rs.family = ${family}`);
}

export async function markSourceRead(
  tx: Pick<Tx, "update">,
  unit: Pick<
    ExtractionUnit,
    "companyId" | "family" | "documentId" | "revisionId" | "extractorVersion"
  >,
): Promise<void> {
  await tx
    .update(relationshipSources)
    .set({
      readRevisionId: unit.revisionId,
      readExtractorVersion: unit.extractorVersion,
      lastReadAt: new Date(),
      lastError: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(relationshipSources.companyId, unit.companyId),
        eq(relationshipSources.family, unit.family),
        eq(relationshipSources.documentId, unit.documentId),
      ),
    );
}

interface LiveObservation {
  id: number;
  supplier: number;
  customer: number;
  bucket: CostBucket;
  basis: ValueBasis;
  pct: number | null;
  valueCr: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  fiscalYear: number | null;
  claim: string;
  confidence: number;
  status: string;
  disclosedBy: "supplier" | "customer" | "third_party";
  disclosureKind: "major_customer" | "related_party" | "segment" | "contract" | "press" | "manual";
  family: SourceFamily;
  version: number;
  documentId: number;
  disclosedOn: string;
}

const BASIS_RANK: Record<ValueBasis, number> = {
  revenue_share: 4,
  purchase_share: 4,
  annual_flow: 3,
  contract_total: 2,
  unknown: 1,
};
const STATUS_RANK: Record<string, number> = { confirmed: 3, auto: 2, pending: 1 };

export function bestObservation<
  T extends Pick<LiveObservation, "basis" | "status" | "disclosedOn" | "confidence" | "id">,
>(rows: readonly T[]): T | null {
  return (
    [...rows].sort(
      (a, b) =>
        BASIS_RANK[b.basis] - BASIS_RANK[a.basis] ||
        (STATUS_RANK[b.status] ?? 0) - (STATUS_RANK[a.status] ?? 0) ||
        b.disclosedOn.localeCompare(a.disclosedOn) ||
        b.confidence - a.confidence ||
        b.id - a.id,
    )[0] ?? null
  );
}

export async function materializeEdges(
  tx: Tx,
  pairs: ReadonlyArray<readonly [number, number]>,
  graphRevision: number,
): Promise<number> {
  if (!pairs.length) return 0;
  const pairSql = sql.join(
    pairs.map(([s, c]) => sql`(${s}::int, ${c}::int)`),
    sql`, `,
  );
  const live = await tx.execute<{
    id: number;
    supplier: number;
    customer: number;
    bucket: CostBucket;
    basis: ValueBasis;
    pct: number | null;
    value_cr: string | null;
    period_start: string | null;
    period_end: string | null;
    fiscal_year: number | null;
    claim: string;
    confidence: number;
    status: string;
    disclosed_by: LiveObservation["disclosedBy"];
    disclosure_kind: LiveObservation["disclosureKind"];
    family: SourceFamily;
    version: number;
    document_id: number;
    disclosed_on: string;
  }>(sql`
    select o.id, o.supplier_counterparty_id as supplier, o.customer_counterparty_id as customer,
      o.cost_bucket as bucket, o.value_basis as basis, o.pct, o.value_cr, o.period_start::text,
      o.period_end::text, o.fiscal_year, o.claim, o.confidence, o.status,
      o.disclosed_by, o.disclosure_kind, e.extractor_family as family,
      e.extractor_version as version, r.document_id,
      least(coalesce(o.period_end, r.published_at::date, o.created_at::date),
        o.created_at::date)::text as disclosed_on
    from relationship_observations o
    join relationship_extractions e on e.id = o.extraction_id
    join document_revisions r on r.id = e.document_revision_id
    where (o.supplier_counterparty_id, o.customer_counterparty_id) in (${pairSql})
      and o.status in (${sql.join(
        LIVE.map((s) => sql`${s}`),
        sql`, `,
      )})`);
  const ids = [...new Set(pairs.flat())];
  const parties = await tx
    .select({
      id: counterparties.id,
      name: counterparties.canonicalName,
      companyId: counterparties.companyId,
    })
    .from(counterparties)
    .where(inArray(counterparties.id, ids));
  const partyOf = new Map(parties.map((p) => [p.id, p]));
  const blocked = await tx.execute<{ supplier: number; customer: number }>(sql`
    select supplier_counterparty_id as supplier, customer_counterparty_id as customer
    from relationship_blocks
    where (supplier_counterparty_id, customer_counterparty_id) in (${pairSql})`);
  const blockedPairs = new Set(blocked.map((b) => `${b.supplier}|${b.customer}`));

  const groups = new Map<string, LiveObservation[]>();
  for (const r of live) {
    const row: LiveObservation = {
      id: Number(r.id),
      supplier: Number(r.supplier),
      customer: Number(r.customer),
      bucket: r.bucket,
      basis: r.basis,
      pct: r.pct === null ? null : Number(r.pct),
      valueCr: r.value_cr,
      periodStart: r.period_start,
      periodEnd: r.period_end,
      fiscalYear: r.fiscal_year === null ? null : Number(r.fiscal_year),
      claim: r.claim,
      confidence: Number(r.confidence),
      status: r.status,
      disclosedBy: r.disclosed_by,
      disclosureKind: r.disclosure_kind,
      family: r.family,
      version: Number(r.version),
      documentId: Number(r.document_id),
      disclosedOn: r.disclosed_on,
    };
    const key = edgeKey(row.supplier, row.customer, row.bucket);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }

  const today = isoDate(new Date());
  const kept = new Set<string>();
  let written = 0;
  for (const [key, rows] of groups) {
    const best = bestObservation(rows) as LiveObservation;
    const supplier = partyOf.get(best.supplier);
    const customer = partyOf.get(best.customer);
    if (!supplier || !customer) continue;
    const lastDisclosedAt = rows.reduce(
      (max, r) => (r.disclosedOn > max ? r.disclosedOn : max),
      best.disclosedOn,
    );
    const validFrom = rows.reduce((min, r) => {
      const from = r.periodStart ?? r.disclosedOn;
      return from < min ? from : min;
    }, best.periodStart ?? best.disclosedOn);
    const validTo = isoDate(addYears(new Date(lastDisclosedAt), EDGE_LIFETIME_YEARS));
    const pairBlocked = blockedPairs.has(`${best.supplier}|${best.customer}`);
    const status = pairBlocked ? "blocked" : validTo >= today ? "active" : "expired";
    const valued = best.basis === "contract_total" || best.basis === "annual_flow";
    const sourceDocumentId = (await documentCollides(tx, key, {
      supplierName: supplier.name,
      customerName: customer.name,
      disclosureKind: best.disclosureKind,
      fiscalYear: best.fiscalYear,
      documentId: best.documentId,
    }))
      ? null
      : best.documentId;
    const values = {
      supplierCompanyId: supplier.companyId,
      supplierName: supplier.name,
      customerCompanyId: customer.companyId,
      customerName: customer.name,
      supplierCounterpartyId: supplier.id,
      customerCounterpartyId: customer.id,
      edgeKey: key,
      costBucket: best.bucket,
      disclosedBy: best.disclosedBy,
      disclosureKind: best.disclosureKind,
      disclosedPct: best.pct,
      disclosedValue: valued ? best.valueCr : null,
      valueBasis: best.basis,
      fiscalYear: best.fiscalYear,
      validFrom,
      validTo,
      confidence: Math.max(...rows.map((r) => r.confidence)),
      evidence: best.claim.slice(0, EVIDENCE_MAX),
      sourceDocumentId,
      extractorFamily: best.family,
      extractorVersion: best.version,
      graphRevision,
      status: status as "active" | "expired" | "blocked",
      supersededById: null,
      lastDisclosedAt,
      observationCount: rows.length,
      updatedAt: new Date(),
    };
    await tx
      .insert(relationships)
      .values(values)
      .onConflictDoUpdate({ target: relationships.edgeKey, set: values });
    kept.add(key);
    written++;
  }

  const keptKeys = [...kept];
  for (const [s, c] of pairs) {
    const pair = and(
      eq(relationships.supplierCounterpartyId, s),
      eq(relationships.customerCounterpartyId, c),
    );
    if (blockedPairs.has(`${s}|${c}`)) {
      await tx
        .update(relationships)
        .set({ status: "blocked", graphRevision, updatedAt: new Date() })
        .where(and(pair, inArray(relationships.status, ["active", "expired", "superseded"])));
      continue;
    }
    await tx
      .update(relationships)
      .set({ status: "superseded", observationCount: 0, graphRevision, updatedAt: new Date() })
      .where(
        and(
          pair,
          inArray(relationships.status, ["active", "expired"]),
          keptKeys.length ? sql`not (${inArray(relationships.edgeKey, keptKeys)})` : undefined,
        ),
      );
  }
  return written;
}

async function documentCollides(
  tx: Tx,
  key: string,
  edge: {
    supplierName: string;
    customerName: string;
    disclosureKind: string;
    fiscalYear: number | null;
    documentId: number;
  },
): Promise<boolean> {
  if (edge.fiscalYear === null) return false;
  const rows = await tx.execute(sql`
    select 1 from relationships
    where supplier_name = ${edge.supplierName} and customer_name = ${edge.customerName}
      and disclosure_kind = ${edge.disclosureKind} and fiscal_year = ${edge.fiscalYear}
      and source_document_id = ${edge.documentId}
      and edge_key is distinct from ${key}
    limit 1`);
  return rows.length > 0;
}

export async function refreshGraphState(
  tx: Pick<Tx, "execute">,
  companyId: number,
  graphRevision: number,
  extractorVersion: number | null,
): Promise<void> {
  await tx.execute(sql`
    insert into company_graph_state as g (company_id, graph_revision, extractor_version,
      documents_available, documents_read, observations, edges, last_disclosed_at, rebuilt_at,
      updated_at)
    select ${companyId}, ${graphRevision}, coalesce(${extractorVersion}::smallint, 0),
      (select count(*) from relationship_sources
        where company_id = ${companyId} and family <> 'legacy'),
      (select count(*) from relationship_sources
        where company_id = ${companyId} and family <> 'legacy' and read_revision_id is not null),
      (select count(*) from relationship_observations
        where focal_company_id = ${companyId} and status in ('pending', 'auto', 'confirmed')),
      (select count(*) from relationships
        where (supplier_company_id = ${companyId} or customer_company_id = ${companyId})
          and status = 'active'),
      (select max(last_disclosed_at) from relationships
        where (supplier_company_id = ${companyId} or customer_company_id = ${companyId})
          and status in ('active', 'expired')),
      case when ${extractorVersion}::smallint is null then null else now() end, now()
    on conflict (company_id) do update set
      graph_revision = greatest(g.graph_revision, excluded.graph_revision),
      extractor_version = coalesce(${extractorVersion}::smallint, g.extractor_version),
      documents_available = excluded.documents_available,
      documents_read = excluded.documents_read,
      observations = excluded.observations,
      edges = excluded.edges,
      last_disclosed_at = excluded.last_disclosed_at,
      rebuilt_at = coalesce(excluded.rebuilt_at, g.rebuilt_at),
      updated_at = excluded.updated_at`);
}

export async function nextGraphRevision(
  tx: Pick<Tx, "select">,
  companyId: number,
): Promise<number> {
  const [row] = await tx
    .select({ revision: companyGraphState.graphRevision })
    .from(companyGraphState)
    .where(eq(companyGraphState.companyId, companyId));
  return (row?.revision ?? 0) + 1;
}
