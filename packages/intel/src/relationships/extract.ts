import { DeadlineExceededError, type Logger, sha256 } from "@ma/core";
import { companies, type Db, eq, fencedTransaction, sql, type Tx } from "@ma/db";
import {
  type AliasEntry,
  type AliasMatcher,
  blockKey,
  type CostBucket,
  type CueClass,
  classifyCostBucket,
  type DisclosedBy,
  type DocumentStore,
  type ExtractionUnit,
  inputsHash,
  loadCounterpartyMatcher,
  looksLikeMarkup,
  maskMarkup,
  nextGraphRevision,
  normalizeCompanyName,
  type Observation,
  type OrderStatus,
  type Party,
  type Period,
  type ResolvedCounterparty,
  recordExtractionFailure,
  refreshGraphState,
  resolveCounterparty,
  type SourceFamily,
  sameGroup,
  succeededExtraction,
  syncCounterparties,
  type ValueBasis,
  writeExtraction,
} from "@ma/ingest";
import { estimateTokens, LlmBudgetExceeded, type LlmClient, PROMPT_TOKEN_LIMIT } from "@ma/llm";
import { fiscalYearOf } from "../estimates.js";
import { inputMessage } from "../insights/prompts.js";
import { type GroundedClaim, type GroundingFailure, groundClaim } from "./grounding.js";
import { RELATIONSHIP_PROMPT_VERSION } from "./prompts.js";
import { type RelationshipClaim, relationshipExtractionSchema } from "./schemas.js";
import { type Cue, type Section, selectSections } from "./sections.js";

export type ClaimRole = RelationshipClaim["role"];

export interface LlmDocument {
  companyId: number;
  family: SourceFamily;
  documentId: number;
  revisionId: number;
  url: string;
  contentType: string | null;
  label: string | null;
  publishedAt: string | null;
}

export interface LlmSource {
  name: string;
  extractorVersion: number;
  system: string;
  cues: readonly Cue[];
  sectionTokens: number;
  maxOutputTokens: number;
  maxConfidence: number;
  minScore: number;
  thirdParty: boolean;
  roles: readonly ClaimRole[];
  markRead: boolean;
  families: readonly SourceFamily[];
  prepare?: (text: string) => string;
  pendingWhere?: ReturnType<typeof sql>;
  period(doc: LlmDocument, text: string): Period;
}

export interface PendingScope {
  companyId: number | null;
  limit: number;
}

export interface RelationshipLlmContext {
  db: Db;
  llm: LlmClient;
  logger: Logger;
  docs: Pick<DocumentStore, "text" | "revision">;
}

export interface LlmExtractionOptions {
  signal?: AbortSignal;
  matcher?: AliasMatcher;
}

export const MIN_CLAIM_CONFIDENCE = 0.4;
export const MAX_CLAIMS_PER_DOCUMENT = 12;
const FAILED_RETRY_DAYS = 7;
const PROMPT_SAFETY_TOKENS = 300;
const NEW_COUNTERPARTY_PENALTY = 0.1;

const GENERIC_LEAD =
  /^(?:a|an|the|our|its|their|one|two|three|some|many|several|various|multiple|other|certain|leading|large|major|key|top|marquee|reputed|global|domestic|international)\b/i;
const GENERIC_WORDS = new Set([
  "customer",
  "customers",
  "client",
  "clients",
  "supplier",
  "suppliers",
  "vendor",
  "vendors",
  "oem",
  "oems",
  "company",
  "companies",
  "group",
  "government",
  "govt",
  "india",
  "indian",
  "psu",
  "psus",
  "state",
  "central",
  "public",
  "sector",
  "undertaking",
  "undertakings",
  "utility",
  "utilities",
  "export",
  "exports",
  "market",
  "markets",
]);

export function isGenericName(name: string): boolean {
  if (GENERIC_LEAD.test(name.trim())) return true;
  const tokens = normalizeCompanyName(name).split(/\s+/).filter(Boolean);
  return tokens.every((t) => GENERIC_WORDS.has(t));
}

export function llmInputsHash(
  contentSha256: string,
  extractorVersion: number,
  model: string,
  sections: readonly Section[],
): string {
  const layout = sections.map((s) => `${s.evidenceId}:${s.start}-${s.end}`).join(",");
  return inputsHash(
    contentSha256,
    extractorVersion,
    sha256(`${RELATIONSHIP_PROMPT_VERSION}|${model}|${layout}`),
  );
}

export interface ClaimShape {
  valueBasis: ValueBasis;
  cueClass: CueClass;
  pct: number | null;
  valueCr: number | null;
  currency: string | null;
  orderStatus: OrderStatus | null;
  costBucket: CostBucket;
}

export function shapeClaim(g: GroundedClaim): ClaimShape {
  const c = g.claim;
  const share = c.valueBasis === "revenue_share" || c.valueBasis === "purchase_share";
  const pct = share ? g.pct : null;
  const order =
    c.valueBasis === "contract_total" || c.disclosureKind === "contract" || c.orderStatus !== null;
  let valueBasis: ValueBasis = c.valueBasis;
  if (share && pct === null) valueBasis = "unknown";
  if (c.valueBasis === "annual_flow" && g.money === null) valueBasis = "unknown";
  if (c.valueBasis === "unknown" && order) valueBasis = "contract_total";
  const valued = valueBasis === "annual_flow" || valueBasis === "contract_total";
  const cueClass: CueClass =
    valueBasis === "revenue_share" || valueBasis === "purchase_share"
      ? valueBasis
      : order
        ? "order"
        : "mention";
  const rule = classifyCostBucket(g.quote);
  return {
    valueBasis,
    cueClass,
    pct,
    valueCr: valued ? (g.money?.valueCr ?? null) : null,
    currency: valued ? (g.money?.currency ?? null) : null,
    orderStatus: cueClass === "order" ? (c.orderStatus ?? "awarded") : null,
    costBucket: rule !== "UNKNOWN" ? rule : c.costBucket,
  };
}

export function claimConfidence(
  claim: RelationshipClaim,
  source: Pick<LlmSource, "maxConfidence">,
  created: boolean,
): number {
  const base = Math.min(Math.max(claim.confidence, 0), 1, source.maxConfidence);
  const c = created ? base - NEW_COUNTERPARTY_PENALTY : base;
  return Math.round(Math.max(0, c) * 100) / 100;
}

export function groundClaims(
  claims: readonly RelationshipClaim[],
  sections: readonly Section[],
  text: string,
  roles: readonly ClaimRole[],
): { grounded: GroundedClaim[]; failures: Partial<Record<GroundingFailure | "role", number>> } {
  const grounded: GroundedClaim[] = [];
  const failures: Partial<Record<GroundingFailure | "role", number>> = {};
  for (const claim of claims) {
    if (!roles.includes(claim.role)) {
      failures.role = (failures.role ?? 0) + 1;
      continue;
    }
    const g = groundClaim(claim, sections, text);
    if (typeof g === "string") failures[g] = (failures[g] ?? 0) + 1;
    else grounded.push(g);
  }
  return { grounded, failures };
}

function party(entry: Party): Party {
  return { counterpartyId: entry.counterpartyId, companyId: entry.companyId, name: entry.name };
}

function excluded(entry: AliasEntry, focal: AliasEntry): boolean {
  return (
    entry.counterpartyId === focal.counterpartyId ||
    (entry.companyId !== null && entry.companyId === focal.companyId) ||
    entry.kind === "group" ||
    sameGroup(entry, focal)
  );
}

async function counterpartyOf(
  tx: Tx,
  matcher: AliasMatcher,
  claim: RelationshipClaim,
): Promise<ResolvedCounterparty | null> {
  const name = claim.counterparty.trim();
  const symbol = matcher.symbols.get(name);
  if (symbol) return { ...symbol, created: false };
  if (isGenericName(name)) return null;
  const kind = claim.counterpartyKind === "company" ? "private" : claim.counterpartyKind;
  return resolveCounterparty(tx, matcher, name, kind);
}

export async function observationsFromClaims(
  tx: Tx,
  read: {
    source: Pick<LlmSource, "maxConfidence" | "thirdParty">;
    focal: AliasEntry;
    matcher: AliasMatcher;
  },
  grounded: readonly GroundedClaim[],
  period: Period,
): Promise<{ observations: Observation[]; dropped: number }> {
  const observations: Observation[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const g of grounded.slice(0, MAX_CLAIMS_PER_DOCUMENT)) {
    const other = await counterpartyOf(tx, read.matcher, g.claim);
    if (!other || excluded(other, read.focal)) {
      dropped++;
      continue;
    }
    const focalSupplies = g.claim.role === "customer";
    const supplier = focalSupplies ? read.focal : other;
    const customer = focalSupplies ? other : read.focal;
    const confidence = claimConfidence(g.claim, read.source, other.created);
    const key = `${supplier.counterpartyId}|${customer.counterpartyId}|${g.start}|${g.end}`;
    if (
      confidence < MIN_CLAIM_CONFIDENCE ||
      seen.has(key) ||
      read.matcher.blocks.has(blockKey(supplier.counterpartyId, customer.counterpartyId))
    ) {
      dropped++;
      continue;
    }
    seen.add(key);
    const disclosedBy: DisclosedBy = read.source.thirdParty
      ? "third_party"
      : focalSupplies
        ? "supplier"
        : "customer";
    observations.push({
      supplier: party(supplier),
      customer: party(customer),
      disclosedBy,
      disclosureKind: g.claim.disclosureKind,
      ...shapeClaim(g),
      period,
      claim: g.quote,
      confidence,
      matched: g.claim.counterparty,
      newCounterparty: other.created,
      start: g.start,
      end: g.end,
    });
  }
  return {
    observations,
    dropped: dropped + Math.max(0, grounded.length - MAX_CLAIMS_PER_DOCUMENT),
  };
}

export interface LlmDocumentResult {
  status: "extracted" | "skipped" | "failed";
  observations: number;
  dropped: number;
  edges: number;
  tokens: number;
}

const SKIPPED: LlmDocumentResult = {
  status: "skipped",
  observations: 0,
  dropped: 0,
  edges: 0,
  tokens: 0,
};

export function llmDocumentCost(
  source: Pick<LlmSource, "system" | "sectionTokens" | "maxOutputTokens">,
): number {
  return (
    estimateTokens(source.system) +
    source.sectionTokens +
    source.maxOutputTokens +
    PROMPT_SAFETY_TOKENS
  );
}

async function budgetGate(ctx: RelationshipLlmContext, need: number): Promise<void> {
  const budget = ctx.llm.budget;
  if (!budget) return;
  if ((await budget.remainingToday("relationships")) >= need) return;
  throw new LlmBudgetExceeded(
    await budget.usedToday("relationships"),
    budget.capOf("relationships"),
    "relationships",
  );
}

async function focalOf(
  ctx: RelationshipLlmContext,
  companyId: number,
  given: AliasMatcher | undefined,
  signal: AbortSignal | undefined,
): Promise<{ matcher: AliasMatcher; focal: AliasEntry }> {
  let matcher = given ?? (await loadCounterpartyMatcher(ctx.db));
  let focal = matcher.byCompany.get(companyId) ?? null;
  if (!focal) {
    await syncCounterparties(ctx.db, signal);
    matcher = await loadCounterpartyMatcher(ctx.db);
    focal = matcher.byCompany.get(companyId) ?? null;
  }
  if (!focal) throw new Error(`company ${companyId} has no counterparty`);
  return { matcher, focal };
}

export async function extractLlmDocument(
  ctx: RelationshipLlmContext,
  source: LlmSource,
  doc: LlmDocument,
  opts: LlmExtractionOptions = {},
): Promise<LlmDocumentResult> {
  const signal = opts.signal ?? null;
  const [company] = await ctx.db
    .select({ name: companies.name, symbol: companies.nseSymbol })
    .from(companies)
    .where(eq(companies.id, doc.companyId));
  if (!company) throw new Error(`company ${doc.companyId} not found`);
  const revision = await ctx.docs.revision(doc.revisionId);
  if (!revision) return SKIPPED;
  const raw = await ctx.docs.text(revision);
  const masked = looksLikeMarkup(raw, doc.contentType) ? maskMarkup(raw) : raw;
  const text = source.prepare ? source.prepare(masked) : masked;
  const header = {
    company,
    document: { kind: source.name, title: doc.label, published: doc.publishedAt },
  };
  const room =
    PROMPT_TOKEN_LIMIT -
    estimateTokens(source.system) -
    estimateTokens(inputMessage({ ...header, sections: [] })) -
    PROMPT_SAFETY_TOKENS;
  const sections = selectSections(text, source.cues, {
    budgetTokens: Math.min(source.sectionTokens, room),
    minScore: source.minScore,
  });
  const graphRevision = await nextGraphRevision(ctx.db, doc.companyId);
  const unit: ExtractionUnit = {
    companyId: doc.companyId,
    family: doc.family,
    extractorVersion: source.extractorVersion,
    inputsHash: llmInputsHash(
      revision.contentSha256,
      source.extractorVersion,
      ctx.llm.model,
      sections,
    ),
    documentId: doc.documentId,
    revisionId: revision.id,
    pageMap: revision.pageMap,
    graphRevision,
  };
  if (await succeededExtraction(ctx.db, unit)) return SKIPPED;
  const { matcher, focal } = await focalOf(ctx, doc.companyId, opts.matcher, opts.signal);
  const write = (
    found: (tx: Tx) => Promise<{ observations: Observation[]; dropped: number }>,
    tokens: number,
  ) =>
    fencedTransaction(
      ctx.db,
      async (tx) => {
        const written = await writeExtraction(tx, unit, await found(tx), {
          tokens,
          markRead: source.markRead,
        });
        await refreshGraphState(tx, doc.companyId, graphRevision, null);
        return written;
      },
      signal,
    );
  if (!sections.length) {
    const written = await write(async () => ({ observations: [], dropped: 0 }), 0);
    return { ...SKIPPED, status: "extracted", edges: written.edges };
  }
  const user = inputMessage({
    ...header,
    sections: sections.map((s) => ({ evidenceId: s.evidenceId, text: s.text })),
  });
  await budgetGate(ctx, estimateTokens(source.system + user) + source.maxOutputTokens);
  try {
    const res = await ctx.llm.complete({
      name: `relationships_${source.name}`,
      system: source.system,
      user,
      schema: relationshipExtractionSchema,
      maxOutputTokens: source.maxOutputTokens,
      temperature: 0,
      budgetClass: "relationships",
    });
    const tokens = res.promptTokens + res.completionTokens;
    const { grounded, failures } = groundClaims(res.data.claims, sections, text, source.roles);
    const ungrounded = res.data.claims.length - grounded.length;
    if (ungrounded) {
      ctx.logger.info(
        { companyId: doc.companyId, documentId: doc.documentId, source: source.name, failures },
        "ungrounded relationship claims dropped",
      );
    }
    const period = source.period(doc, text);
    const read = { source, focal, matcher };
    const written = await write(async (tx) => {
      const found = await observationsFromClaims(tx, read, grounded, period);
      return { observations: found.observations, dropped: found.dropped + ungrounded };
    }, tokens);
    return {
      status: "extracted",
      observations: written.observations,
      dropped: written.dropped,
      edges: written.edges,
      tokens,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const deferred =
      err instanceof LlmBudgetExceeded ||
      err instanceof DeadlineExceededError ||
      signal?.aborted === true;
    await recordExtractionFailure(ctx.db, unit, deferred ? "deferred" : "failed", message);
    if (deferred) throw err;
    ctx.logger.warn(
      { err, companyId: doc.companyId, documentId: doc.documentId, source: source.name },
      "llm relationship extraction failed",
    );
    return { ...SKIPPED, status: "failed" };
  }
}

export async function pendingLlmDocuments(
  db: Db,
  q: Pick<LlmSource, "families" | "extractorVersion" | "pendingWhere">,
  scope: PendingScope,
): Promise<LlmDocument[]> {
  const families = sql.join(
    q.families.map((f) => sql`${f}`),
    sql`, `,
  );
  const rows = await db.execute<LlmDocumentRow>(sql`
    select rs.company_id, rs.family::text as family, rs.document_id,
      d.current_revision_id as revision_id, d.url, d.content_type, rs.label,
      rs.published_at::text as published_at
    from relationship_sources rs
    join documents d on d.id = rs.document_id
    where rs.family in (${families})
      ${scope.companyId === null ? sql`` : sql`and rs.company_id = ${scope.companyId}`}
      and d.current_revision_id is not null
      and not exists (
        select 1 from relationship_extractions l
        where l.document_revision_id = d.current_revision_id
          and l.extractor_family = rs.family and l.extractor_version = ${q.extractorVersion}
          and (l.status = 'succeeded' or (l.status = 'failed'
            and l.finished_at > now() - make_interval(days => ${FAILED_RETRY_DAYS}))))
      ${q.pendingWhere ? sql`and ${q.pendingWhere}` : sql``}
    order by rs.published_at desc nulls last, rs.document_id desc
    limit ${scope.limit}`);
  return rows.map(toLlmDocument);
}

type LlmDocumentRow = {
  company_id: number;
  family: SourceFamily;
  document_id: number;
  revision_id: number;
  url: string;
  content_type: string | null;
  label: string | null;
  published_at: string | null;
};

function toLlmDocument(r: LlmDocumentRow): LlmDocument {
  return {
    companyId: Number(r.company_id),
    family: r.family,
    documentId: Number(r.document_id),
    revisionId: Number(r.revision_id),
    url: r.url,
    contentType: r.content_type,
    label: r.label,
    publishedAt: r.published_at,
  };
}

export async function loadLlmDocument(
  db: Db,
  source: Pick<LlmSource, "families">,
  companyId: number,
  documentId: number,
): Promise<LlmDocument | null> {
  const families = sql.join(
    source.families.map((f) => sql`${f}`),
    sql`, `,
  );
  const [row] = await db.execute<LlmDocumentRow>(sql`
    select rs.company_id, rs.family::text as family, rs.document_id,
      d.current_revision_id as revision_id, d.url, d.content_type, rs.label,
      rs.published_at::text as published_at
    from relationship_sources rs
    join documents d on d.id = rs.document_id
    where rs.company_id = ${companyId} and rs.document_id = ${documentId}
      and rs.family in (${families}) and d.current_revision_id is not null
    limit 1`);
  return row ? toLlmDocument(row) : null;
}

export function publishedPeriod(publishedAt: string | null): Period {
  if (!publishedAt) return { start: null, end: null, fiscalYear: null };
  const day = publishedAt.slice(0, 10);
  return { start: null, end: day, fiscalYear: fiscalYearOf(day) };
}
