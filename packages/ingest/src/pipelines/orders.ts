import { DAY, DeadlineExceededError, isoDate, remainingMs, throwIfAborted } from "@ma/core";
import { companies, eq, fencedTransaction, sql, type Tx } from "@ma/db";
import type { IngestContext } from "../context.js";
import type { FetchDocumentResult } from "../documents.js";
import {
  type AliasEntry,
  type AliasMatcher,
  blockKey,
  type CostBucket,
  type CounterpartyKind,
  findMentions,
  normalizeCompanyName,
  type Observation,
  type OrderStatus,
  type Party,
  type Period,
  sameGroup,
} from "../extract/relationships.js";
import {
  type Clause,
  executionMonths,
  findMoney,
  looksLikeMarkup,
  type Money,
  maskMarkup,
  splitClauses,
} from "../extract/text.js";
import {
  loadCounterpartyMatcher,
  resolveCounterparty,
  syncCounterparties,
} from "../relationships/counterparties.js";
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

export const ORDER_RELATIONSHIP_EXTRACTOR_VERSION = 1;

export type OrderFamily = "order_filing" | "announcement_metadata";

const ORDER_TERMS = [
  "(?:work|purchase|supply|service|export|repeat|new|domestic|international|epc|turnkey) orders?",
  "orders? (?:win|wins|won|received|receipt|inflows?|worth|valued|valuing|aggregating|amounting|from|of (?:rs|inr|usd|value|worth))",
  "receipt of (?:an? |the )?(?:new |repeat )?(?:orders?|contracts?|loa|loi|letters? of)",
  "letters? of (?:award|acceptance|intent)",
  "loa|loi|noa",
  "bag(?:s|ged|ging)",
  "award(?:ed|s|ing)? (?:of )?(?:an? |the )?(?:new )?(?:contracts?|orders?|projects?|works?|tenders?)",
  "contracts? (?:awarded|win|wins|won|received|from|worth|valued|with)",
  "secur(?:es|ed|ing) (?:an? |the )?(?:[a-z0-9-]+ ){0,3}(?:orders?|contracts?|projects?|mandates?)",
  "wins? (?:an? |the )?(?:[a-z0-9-]+ ){0,3}(?:orders?|contracts?|projects?)",
  "lowest bidder|l-?1 bidder",
].join("|");

const NON_COMMERCIAL_TERMS = [
  "court|tribunal|nclt|nclat|income tax|tax demand|demand notice|gst (?:demand|order|notice|authorit[a-z]*)",
  "penalt(?:y|ies)|show cause|assessment order|arbitra[a-z]*|adjudicat[a-z]*|interim order",
  "winding up|insolvency|appointment|remuneration|employment|trading window|esop|allotment",
  "postal ballot|record date|book closure|transcript|financial results",
].join("|");

export const ORDER_SUBJECT_PATTERN = `\\y(?:${ORDER_TERMS})\\y`;
export const NON_COMMERCIAL_PATTERN = `\\y(?:${NON_COMMERCIAL_TERMS})\\y`;

const ORDER_SUBJECT = new RegExp(ORDER_SUBJECT_PATTERN.replaceAll("\\y", "\\b"), "i");
const NON_COMMERCIAL = new RegExp(NON_COMMERCIAL_PATTERN.replaceAll("\\y", "\\b"), "i");
const CLAUSE_CUE =
  /\b(?:orders?|contracts?|LoA|LoI|NoA|letters? of (?:award|intent|acceptance)|bag(?:s|ged|ging)|award(?:ed|s)?|L-?1|lowest bidder)\b/i;
const CANCELLED =
  /\b(?:cancel(?:led|lation|s)?|terminat(?:ed|ion|es)|withdraw(?:n|al)?|foreclos(?:ed|ure)|short-?closed?)\b/i;
const PENDING =
  /\b(?:L-?1|lowest bidder|letters? of intent|LoI|emerged as|in-?principle|under negotiation|subject to (?:the )?(?:signing|execution|approval))\b/i;
const INFRA =
  /\b(?:EPC|turnkey|construction|civil|infrastructure|highways?|roads?|bridges?|tunnels?|flyovers?|expressways?|metro|railways?|electrification|signalling|substations?|transmission|commissioning|erection|installation|irrigation|pipelines?|water supply|sewerage|buildings?|housing|airports?|ports?|dams?|power plants?|solar|rolling stock|locomotives?|wagons?|coaches|transformers?|turbines?|switchgears?)\b/i;
const CUE_BEFORE =
  /\b(?:from|by|with|placed by|issued by|awarded by)\s+(?:M\/s\.?\s*)?(?:the\s+)?$/i;
const CUE_AFTER =
  /^\s*(?:\([^)]{1,40}\)\s*)?,?\s*(?:has|have)?\s*(?:awarded|placed|issued|granted)\b/i;
const AWARDER =
  /\b(?:from|by|placed by|issued by|awarded by)\s+(?:M\/s\.?\s*)?(?:the\s+)?(?=[A-Z])/g;
const NAME_TOKEN = /^[A-Z][A-Za-z0-9&.'’()/-]*[,;:]?$/;
const NAME_STOP = new Set([
  "worth",
  "valued",
  "valuing",
  "amounting",
  "aggregating",
  "for",
  "towards",
  "to",
  "in",
  "at",
  "under",
  "vide",
  "dated",
  "through",
  "on",
  "with",
  "from",
  "by",
  "against",
  "regarding",
  "amount",
  "value",
  "being",
  "which",
  "who",
  "that",
  "having",
  "is",
  "has",
  "have",
  "was",
  "the",
  "rs",
  "rs.",
  "inr",
  "usd",
]);
const NAME_JOINERS = new Set(["of", "and", "&"]);
const GENERIC_HEAD =
  /^(?:A|An|One|Our|Its|Their|This|That|These|Leading|Major|Reputed|Reputable|Large|Global|International|Domestic|Prestigious|Marquee|Renowned|Various|Multiple|Several|Existing|New|Repeat|Company|Board|Exchange|Stock|Regulation|Listing|SEBI|NSE|BSE|Rs|INR|USD|EUR|FY|Q[1-4]|Jan\w*|Feb\w*|Mar\w*|Apr\w*|May|Jun\w*|Jul\w*|Aug\w*|Sep\w*|Oct\w*|Nov\w*|Dec\w*)\b/i;
const GENERIC_WORDS = new Set([
  "customer",
  "customers",
  "client",
  "clients",
  "oem",
  "oems",
  "order",
  "orders",
  "contract",
  "contracts",
  "letter",
  "award",
  "company",
  "limited",
  "ltd",
  "india",
  "indian",
  "government",
  "govt",
  "state",
  "central",
  "public",
  "sector",
  "undertaking",
  "psu",
]);
const GOVERNMENT_NAME =
  /\b(?:Ministry|Government|Govt\.?|Authority|Railways?|Nigam|Board|Department|Municipal|Commission|Directorate|Council|Mandal|Parishad|Police|Army|Navy|Air Force|Defence|Metro Rail|Zilla|Panchayat|Development Corporation|Corporation of India)\b/i;
const FOREIGN_NAME = /\b(?:Inc|LLC|GmbH|AG|PLC|SpA|S\.A|B\.V|Pte|Pty|Oy|SAS|KK|FZE|FZCO|WLL)\b\.?/;
const MAX_CLAUSE = 1200;
const MAX_CLAIMS = 5;
const NAME_TOKENS = 10;

export interface OrderAnnouncementInput {
  subject: string;
  categoryKey: string | null;
}

export function isOrderAnnouncement(a: OrderAnnouncementInput): boolean {
  if (NON_COMMERCIAL.test(a.subject)) return false;
  return a.categoryKey === "order_win" || ORDER_SUBJECT.test(a.subject);
}

export const ORDER_ANNOUNCEMENT = sql`((a.category_key = 'order_win' or a.subject ~* ${ORDER_SUBJECT_PATTERN})
  and a.subject !~* ${NON_COMMERCIAL_PATTERN})`;

export function orderAnnouncementUrl(announcementId: number): string {
  return `nse://announcement/${announcementId}`;
}

export const ORDER_ANNOUNCEMENT_UNREAD = sql`not exists (
  select 1 from documents d
  join relationship_sources rs on rs.document_id = d.id
  where d.url = 'nse://announcement/' || a.id and rs.company_id = a.company_id
    and rs.family = 'announcement_metadata'
    and rs.read_extractor_version >= ${ORDER_RELATIONSHIP_EXTRACTOR_VERSION})`;

export interface OrderAwarder {
  entry: AliasEntry | null;
  name: string;
  kind: Exclude<CounterpartyKind, "listed" | "group">;
}

export interface OrderClaim {
  awarder: OrderAwarder;
  money: Money | null;
  months: number | null;
  status: OrderStatus;
  costBucket: CostBucket;
  claim: string;
  start: number;
  end: number;
}

export interface OrderParse {
  claims: OrderClaim[];
  dropped: number;
}

export function orderStatusOf(text: string): OrderStatus {
  if (CANCELLED.test(text)) return "cancelled";
  if (PENDING.test(text)) return "pending";
  return "awarded";
}

export function parseOrderClaims(
  text: string,
  matcher: AliasMatcher,
  focal: AliasEntry,
): OrderParse {
  const status = orderStatusOf(text);
  const costBucket: CostBucket = INFRA.test(text) ? "CAPEX" : "UNKNOWN";
  const months = executionMonths(text);
  const claims = new Map<string, OrderClaim>();
  let dropped = 0;
  for (const clause of splitClauses(text)) {
    if (clause.text.length > MAX_CLAUSE) continue;
    if (!CLAUSE_CUE.test(clause.text) || NON_COMMERCIAL.test(clause.text)) continue;
    const awarder = awarderIn(clause, matcher, focal);
    if (!awarder) {
      if (ORDER_SUBJECT.test(clause.text)) dropped++;
      continue;
    }
    const money = findMoney(clause.text, clause.start)[0] ?? null;
    const key = awarder.entry
      ? `id:${awarder.entry.counterpartyId}`
      : `name:${normalizeCompanyName(awarder.name)}`;
    const prior = claims.get(key);
    if (prior && (prior.money !== null || money === null)) continue;
    claims.set(key, {
      awarder,
      money,
      months,
      status,
      costBucket,
      claim: clause.text.replace(/\s+/g, " ").trim(),
      start: clause.start,
      end: clause.end,
    });
  }
  const out = [...claims.values()];
  const [only] = out;
  if (out.length === 1 && only && only.money === null) only.money = findMoney(text)[0] ?? null;
  return {
    claims: out.slice(0, MAX_CLAIMS),
    dropped: dropped + Math.max(0, out.length - MAX_CLAIMS),
  };
}

function awarderIn(clause: Clause, matcher: AliasMatcher, focal: AliasEntry): OrderAwarder | null {
  const upper = clause.text === clause.text.toUpperCase();
  const mentions = findMentions(clause.text, matcher, {
    offset: clause.start,
    uppercaseContext: upper,
  });
  for (const m of mentions) {
    if (excluded(m.entry, focal)) continue;
    const at = m.start - clause.start;
    const to = m.end - clause.start;
    const before = clause.text.slice(Math.max(0, at - 48), at);
    const after = clause.text.slice(to, to + 48);
    if (CUE_BEFORE.test(before) || CUE_AFTER.test(after)) {
      return { entry: m.entry, name: m.entry.name, kind: awarderKind(m.entry.kind, m.entry.name) };
    }
  }
  for (const m of clause.text.matchAll(AWARDER)) {
    const name = nameAt(clause.text, m.index + m[0].length);
    if (!name) continue;
    const inside = findMentions(name, matcher, { uppercaseContext: upper });
    if (inside.some((x) => excluded(x.entry, focal))) continue;
    const whole = inside.find((x) => x.matched.length >= name.length - 1) ?? null;
    if (whole) {
      return {
        entry: whole.entry,
        name: whole.entry.name,
        kind: awarderKind(whole.entry.kind, name),
      };
    }
    return { entry: null, name, kind: awarderKind(null, name) };
  }
  return null;
}

function excluded(entry: AliasEntry, focal: AliasEntry): boolean {
  return (
    entry.counterpartyId === focal.counterpartyId ||
    (entry.companyId !== null && entry.companyId === focal.companyId) ||
    entry.kind === "group" ||
    sameGroup(entry, focal)
  );
}

function awarderKind(kind: CounterpartyKind | null, name: string): OrderAwarder["kind"] {
  if (kind === "government" || kind === "private" || kind === "foreign") return kind;
  if (GOVERNMENT_NAME.test(name)) return "government";
  if (FOREIGN_NAME.test(name)) return "foreign";
  return "private";
}

export function nameAt(text: string, from: number): string | null {
  const words = text.slice(from, from + 160).split(/\s+/);
  const kept: string[] = [];
  for (const word of words) {
    if (kept.length >= NAME_TOKENS || !word || word.startsWith("(")) break;
    const lower = word.toLowerCase().replace(/[,;:]$/, "");
    if (kept.length && NAME_STOP.has(lower)) break;
    if (NAME_JOINERS.has(lower)) {
      kept.push(lower === "&" ? "&" : lower);
      continue;
    }
    if (!NAME_TOKEN.test(word)) break;
    const clean = word.replace(/[,;:]$/, "");
    kept.push(clean);
    if (clean !== word) break;
  }
  while (kept.length && NAME_JOINERS.has((kept[kept.length - 1] as string).toLowerCase()))
    kept.pop();
  const name = kept.join(" ").replace(/[,;:]+$/, "");
  if (!name || GENERIC_HEAD.test(name)) return null;
  const tokens = name
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/[^a-z0-9&]/g, ""));
  if (tokens.every((t) => !t || GENERIC_WORDS.has(t) || NAME_JOINERS.has(t))) return null;
  return normalizeCompanyName(name).length >= 4 ? name : null;
}

export function orderPeriod(publishedAt: Date, months: number | null): Period {
  const start = isoDate(publishedAt);
  const month = publishedAt.getUTCMonth();
  const fiscalYear = publishedAt.getUTCFullYear() + (month >= 3 ? 1 : 0);
  if (months === null) return { start, end: null, fiscalYear };
  const end = new Date(publishedAt.getTime());
  end.setUTCMonth(end.getUTCMonth() + months);
  return { start, end: isoDate(end), fiscalYear };
}

const BASE_CONFIDENCE: Record<OrderFamily, number> = {
  order_filing: 0.8,
  announcement_metadata: 0.75,
};

export function orderConfidence(family: OrderFamily, claim: OrderClaim): number {
  let c = BASE_CONFIDENCE[family];
  if (claim.money) c += 0.05;
  if (!claim.awarder.entry) c -= 0.1;
  if (claim.status === "pending") c -= 0.1;
  return Math.round(Math.min(0.95, Math.max(0.3, c)) * 100) / 100;
}

const DOCUMENT_MS = 20_000;
const ATTACHMENT_RETRY_MS = 7 * DAY;
const STORED_MAX_AGE_MS = 10 * 365 * DAY;
const ORDERS_PER_RUN = 40;

export interface OrderAnnouncement {
  id: number;
  publishedAt: Date;
  subject: string;
  details: string | null;
  attachmentUrl: string | null;
}

export interface OrderExtractionResult {
  announcements: number;
  documents: number;
  skipped: number;
  failed: number;
  remaining: number;
  observations: number;
  dropped: number;
  relationships: number;
}

export async function pendingOrderAnnouncements(
  ctx: Pick<IngestContext, "db">,
  companyId: number,
  force: boolean,
  limit = ORDERS_PER_RUN,
): Promise<OrderAnnouncement[]> {
  const rows = await ctx.db.execute<{
    id: number;
    published_at: string | Date;
    subject: string;
    details: string | null;
    attachment_url: string | null;
  }>(sql`
    select a.id, a.published_at, a.subject, a.details, a.attachment_url
    from announcements a
    where a.company_id = ${companyId} and ${ORDER_ANNOUNCEMENT}
      ${force ? sql`` : sql`and ${ORDER_ANNOUNCEMENT_UNREAD}`}
    order by a.published_at desc
    limit ${limit}`);
  return rows.map((r) => ({
    id: Number(r.id),
    publishedAt: new Date(r.published_at),
    subject: r.subject,
    details: r.details,
    attachmentUrl: r.attachment_url,
  }));
}

export async function extractOrdersForCompany(
  ctx: IngestContext,
  companyId: number,
  matcher: AliasMatcher,
  signal?: AbortSignal,
  opts: { force?: boolean } = {},
): Promise<OrderExtractionResult> {
  const company = await ctx.db.query.companies.findFirst({ where: eq(companies.id, companyId) });
  if (!company) throw new Error(`company ${companyId} not found`);
  let aliases = matcher;
  let focal = aliases.byCompany.get(companyId) ?? null;
  if (!focal) {
    await syncCounterparties(ctx.db, signal);
    aliases = await loadCounterpartyMatcher(ctx.db);
    focal = aliases.byCompany.get(companyId) ?? null;
  }
  if (!focal) throw new Error(`company ${companyId} has no counterparty`);

  const force = opts.force ?? false;
  const read: ReadContext = {
    ctx,
    companyId,
    focal,
    matcher: aliases,
    fingerprint: matcherFingerprint(aliases),
    graphRevision: await nextGraphRevision(ctx.db, companyId),
    force,
    signal: signal ?? null,
  };
  const queue = await pendingOrderAnnouncements(ctx, companyId, force);
  const result: OrderExtractionResult = {
    announcements: 0,
    documents: 0,
    skipped: 0,
    failed: 0,
    remaining: 0,
    observations: 0,
    dropped: 0,
    relationships: 0,
  };
  const tally = (outcome: ReadOutcome) => {
    if (outcome === "skipped") result.skipped++;
    else if (outcome === "failed") result.failed++;
    else {
      result.documents++;
      result.observations += outcome.observations;
      result.dropped += outcome.dropped;
      result.relationships += outcome.edges;
    }
  };

  for (const [i, a] of queue.entries()) {
    throwIfAborted(signal);
    if (remainingMs() < DOCUMENT_MS) {
      result.remaining = queue.length - i;
      break;
    }
    const label = a.subject.slice(0, 300);
    if (a.attachmentUrl) {
      let fetched: FetchDocumentResult | null = null;
      try {
        fetched = await ctx.docs.fetch(a.attachmentUrl, {
          source: "order_filing",
          companyId,
          maxAgeMs: STORED_MAX_AGE_MS,
          publishedAt: a.publishedAt,
          ...(signal ? { signal } : {}),
        });
      } catch (err) {
        if (err instanceof DeadlineExceededError) throw err;
        throwIfAborted(signal);
        ctx.logger.warn({ err, url: a.attachmentUrl }, "order attachment fetch failed");
        await noteSourceError(ctx.db, companyId, "order_filing", a.attachmentUrl, err);
        result.failed++;
        if (Date.now() - a.publishedAt.getTime() < ATTACHMENT_RETRY_MS) continue;
      }
      if (fetched) tally(await readOrderDocument(read, "order_filing", label, a, fetched));
    }
    const content = a.details?.trim() ? `${a.subject}\n${a.details}` : a.subject;
    const inline = await ctx.docs.putInline(orderAnnouncementUrl(a.id), content, {
      source: "announcement_metadata",
      companyId,
      publishedAt: a.publishedAt,
      ...(signal ? { signal } : {}),
    });
    tally(await readOrderDocument(read, "announcement_metadata", label, a, inline));
    result.announcements++;
  }

  await refreshGraphState(ctx.db, companyId, read.graphRevision, null);
  ctx.logger.info({ companyId, ...result }, "order filings extracted");
  return result;
}

interface ReadContext {
  ctx: IngestContext;
  companyId: number;
  focal: AliasEntry;
  matcher: AliasMatcher;
  fingerprint: string;
  graphRevision: number;
  force: boolean;
  signal: AbortSignal | null;
}

type ReadOutcome = "skipped" | "failed" | { observations: number; dropped: number; edges: number };

async function readOrderDocument(
  read: ReadContext,
  family: OrderFamily,
  label: string,
  a: OrderAnnouncement,
  fetched: FetchDocumentResult,
): Promise<ReadOutcome> {
  const { ctx, companyId } = read;
  const { doc, revision } = fetched;
  const registered = await registerSource(ctx.db, {
    companyId,
    family,
    documentId: doc.id,
    label,
    publishedAt: isoDate(a.publishedAt),
  });
  if (
    !read.force &&
    registered.readRevisionId === revision.id &&
    registered.readExtractorVersion === ORDER_RELATIONSHIP_EXTRACTOR_VERSION
  ) {
    return "skipped";
  }
  const unit: ExtractionUnit = {
    companyId,
    family,
    extractorVersion: ORDER_RELATIONSHIP_EXTRACTOR_VERSION,
    inputsHash: inputsHash(
      revision.contentSha256,
      ORDER_RELATIONSHIP_EXTRACTOR_VERSION,
      read.fingerprint,
    ),
    documentId: doc.id,
    revisionId: revision.id,
    pageMap: revision.pageMap,
    graphRevision: read.graphRevision,
  };
  if (await succeededExtraction(ctx.db, unit)) {
    await markSourceRead(ctx.db, unit);
    return "skipped";
  }
  try {
    const text = looksLikeMarkup(fetched.text, doc.contentType)
      ? maskMarkup(fetched.text)
      : fetched.text;
    const parsed = parseOrderClaims(text, read.matcher, read.focal);
    return await fencedTransaction(
      ctx.db,
      async (tx) => {
        const found = await observationsOf(tx, read, family, a, parsed);
        const written = await writeExtraction(tx, unit, found);
        await refreshGraphState(tx, companyId, read.graphRevision, null);
        return {
          observations: written.observations,
          dropped: written.dropped,
          edges: written.edges,
        };
      },
      read.signal,
    );
  } catch (err) {
    const deferred = err instanceof DeadlineExceededError || read.signal?.aborted === true;
    const message = err instanceof Error ? err.message : String(err);
    await recordExtractionFailure(ctx.db, unit, deferred ? "deferred" : "failed", message);
    if (deferred) throw err;
    await noteSourceError(ctx.db, companyId, family, doc.url, err);
    ctx.logger.warn({ err, companyId, documentId: doc.id }, "order extraction failed");
    return "failed";
  }
}

async function observationsOf(
  tx: Tx,
  read: ReadContext,
  family: OrderFamily,
  a: OrderAnnouncement,
  parsed: OrderParse,
): Promise<{ observations: Observation[]; dropped: number }> {
  const observations: Observation[] = [];
  let dropped = parsed.dropped;
  for (const claim of parsed.claims) {
    const customer = claim.awarder.entry
      ? { ...claim.awarder.entry, created: false }
      : await resolveCounterparty(tx, read.matcher, claim.awarder.name, claim.awarder.kind);
    if (
      !customer ||
      excluded(customer, read.focal) ||
      read.matcher.blocks.has(blockKey(read.focal.counterpartyId, customer.counterpartyId))
    ) {
      dropped++;
      continue;
    }
    observations.push({
      supplier: party(read.focal),
      customer: party(customer),
      disclosedBy: "supplier",
      disclosureKind: "contract",
      costBucket: claim.costBucket,
      valueBasis: "contract_total",
      cueClass: "order",
      pct: null,
      valueCr: claim.money?.valueCr ?? null,
      currency: claim.money?.currency ?? null,
      period: orderPeriod(a.publishedAt, claim.months),
      orderStatus: claim.status,
      claim: claim.claim,
      confidence: orderConfidence(family, claim),
      matched: claim.awarder.name,
      newCounterparty: customer.created,
      start: claim.start,
      end: claim.end,
    });
  }
  return { observations, dropped };
}

function party(entry: Party): Party {
  return { counterpartyId: entry.counterpartyId, companyId: entry.companyId, name: entry.name };
}
