import { parseIndianNumber } from "@ma/core";
import {
  type Clause,
  findMoney,
  fiscalPeriod,
  fiscalYearIn,
  splitClauses,
  type Token,
  tokenize,
} from "./text.js";

export const RELATIONSHIP_EXTRACTOR_VERSION = 3;
export const ALIAS_RESOLVER_VERSION = 2;

export type CostBucket = "COGS" | "CAPEX" | "SGA" | "RND" | "UNKNOWN";
export type ValueBasis =
  | "revenue_share"
  | "purchase_share"
  | "annual_flow"
  | "contract_total"
  | "unknown";
export type CueClass =
  | "revenue_share"
  | "purchase_share"
  | "customer_count"
  | "ownership"
  | "order"
  | "mention";
export type DisclosureKind =
  | "major_customer"
  | "related_party"
  | "segment"
  | "contract"
  | "press"
  | "manual";
export type DisclosedBy = "supplier" | "customer" | "third_party";
export type OrderStatus = "awarded" | "pending" | "cancelled";
export type CounterpartyKind = "listed" | "private" | "government" | "foreign" | "group";
export type SourceFamily =
  | "annual_report"
  | "concall"
  | "order_filing"
  | "announcement_metadata"
  | "rating_rationale"
  | "presentation"
  | "screener"
  | "manual";

export interface Party {
  counterpartyId: number;
  companyId: number | null;
  name: string;
}

export interface AliasEntry extends Party {
  kind: CounterpartyKind;
  phrases: readonly string[];
  symbols: readonly string[];
  groupKeys: readonly string[];
}

export interface AliasMatcher {
  phrases: Map<string, AliasEntry>;
  symbols: Map<string, AliasEntry>;
  maxTokens: number;
  entries: Map<number, AliasEntry>;
  byCompany: Map<number, AliasEntry>;
  blocks: Set<string>;
}

export interface Mention {
  entry: AliasEntry;
  matched: string;
  start: number;
  end: number;
  exactCase: boolean;
}

export interface Period {
  start: string | null;
  end: string | null;
  fiscalYear: number | null;
}

export interface Observation {
  supplier: Party;
  customer: Party;
  disclosedBy: DisclosedBy;
  disclosureKind: DisclosureKind;
  costBucket: CostBucket;
  valueBasis: ValueBasis;
  cueClass: CueClass;
  pct: number | null;
  valueCr: number | null;
  currency: string | null;
  period: Period;
  orderStatus: OrderStatus | null;
  claim: string;
  confidence: number;
  matched: string;
  newCounterparty: boolean;
  start: number;
  end: number;
}

export interface ExtractOptions {
  focal: AliasEntry;
  family: SourceFamily;
  period: Period;
}

export interface ExtractResult {
  observations: Observation[];
  dropped: number;
}

export interface ConcentrationDisclosure {
  customersOver10Pct: number;
  revenueFromThem: number | null;
  unit: "crore" | "million" | "lakh" | null;
}

const LEGAL_FORMS = new Set([
  "limited",
  "ltd",
  "pvt",
  "private",
  "inc",
  "incorporated",
  "plc",
  "llp",
  "llc",
  "gmbh",
  "ag",
  "se",
  "sa",
  "nv",
  "bv",
  "spa",
  "pte",
  "pty",
]);
const SOFT_FORMS = new Set(["company", "co", "corporation", "corp"]);

export function normalizeCompanyName(name: string): string {
  const words = tokenize(name.replace(/&amp;/gi, "&")).map((t) => t.key);
  if (words[0] === "the" && words.length > 1) words.shift();
  for (;;) {
    const last = words.at(-1);
    if (last && LEGAL_FORMS.has(last) && words.length > 1) words.pop();
    else if (last && SOFT_FORMS.has(last) && words.length > 2) words.pop();
    else break;
  }
  return words.join(" ");
}

const GENERIC = new Set([
  "india",
  "industries",
  "international",
  "group",
  "power",
  "steel",
  "bank",
  "finance",
  "engineers",
  "motors",
  "chemicals",
  "pharma",
  "energy",
  "infra",
  "cement",
  "capital",
  "financial",
  "government",
  "company",
  "limited",
  "services",
  "technologies",
  "solutions",
  "national",
  "global",
]);

const SYMBOL_SHAPE = /^[A-Z]{3,12}$/;

export function buildAliasMatcher(
  entries: readonly AliasEntry[],
  blocks: ReadonlyArray<readonly [number, number]> = [],
): AliasMatcher {
  const phrases = new Map<string, AliasEntry>();
  const symbols = new Map<string, AliasEntry>();
  const ambiguous = new Set<string>();
  const ambiguousSymbols = new Set<string>();
  let maxTokens = 1;
  for (const entry of entries) {
    const own = normalizeCompanyName(entry.name);
    for (const raw of [entry.name, ...entry.phrases]) {
      const key = normalizeCompanyName(raw);
      const size = key.split(" ").length;
      if (key.length < 4 || (size === 1 && GENERIC.has(key)) || ambiguous.has(key)) continue;
      const prior = phrases.get(key);
      if (prior && prior.counterpartyId !== entry.counterpartyId) {
        const priorOwns = normalizeCompanyName(prior.name) === key;
        if (priorOwns === (own === key)) {
          phrases.delete(key);
          ambiguous.add(key);
          continue;
        }
        if (priorOwns) continue;
      }
      phrases.set(key, entry);
      maxTokens = Math.max(maxTokens, size);
    }
    for (const symbol of entry.symbols) {
      if (!SYMBOL_SHAPE.test(symbol) || ambiguousSymbols.has(symbol)) continue;
      const prior = symbols.get(symbol);
      if (prior && prior.counterpartyId !== entry.counterpartyId) {
        symbols.delete(symbol);
        ambiguousSymbols.add(symbol);
        continue;
      }
      symbols.set(symbol, entry);
    }
  }
  return {
    phrases,
    symbols,
    maxTokens,
    entries: new Map(entries.map((e) => [e.counterpartyId, e])),
    byCompany: new Map(
      entries.flatMap((e) => (e.companyId === null ? [] : [[e.companyId, e] as const])),
    ),
    blocks: new Set(blocks.map(([s, c]) => blockKey(s, c))),
  };
}

export function blockKey(supplierCounterpartyId: number, customerCounterpartyId: number): string {
  return `${supplierCounterpartyId}|${customerCounterpartyId}`;
}

export function findMentions(
  text: string,
  matcher: AliasMatcher,
  opts: { offset?: number; uppercaseContext?: boolean } = {},
): Mention[] {
  const offset = opts.offset ?? 0;
  const tokens = tokenize(text, offset);
  const out: Mention[] = [];
  let i = 0;
  while (i < tokens.length) {
    const phrase = phraseAt(tokens, i, matcher);
    if (phrase) {
      const last = tokens[i + phrase.size - 1] as Token;
      const first = tokens[i] as Token;
      out.push({
        entry: phrase.entry,
        matched: text.slice(first.start - offset, last.end - offset),
        start: first.start,
        end: last.end,
        exactCase: false,
      });
      i += phrase.size;
      continue;
    }
    const token = tokens[i] as Token;
    const symbol = matcher.symbols.get(token.raw);
    if (symbol && (opts.uppercaseContext || !shouting(tokens, i, matcher))) {
      out.push({
        entry: symbol,
        matched: token.raw,
        start: token.start,
        end: token.end,
        exactCase: true,
      });
    }
    i++;
  }
  return out;
}

function phraseAt(
  tokens: readonly Token[],
  i: number,
  matcher: AliasMatcher,
): { entry: AliasEntry; size: number } | null {
  const head = tokens[i] as Token;
  if (!/^[\p{Lu}\p{N}]/u.test(head.raw)) return null;
  for (let size = Math.min(matcher.maxTokens, tokens.length - i); size >= 1; size--) {
    let key = head.key;
    for (let j = 1; j < size; j++) key += ` ${(tokens[i + j] as Token).key}`;
    const entry = matcher.phrases.get(key);
    if (entry) return { entry, size };
  }
  return null;
}

function shouting(tokens: readonly Token[], i: number, matcher: AliasMatcher): boolean {
  const loud = (t: Token | undefined) =>
    t !== undefined && /^\p{Lu}{2,}$/u.test(t.raw) && !matcher.symbols.has(t.raw);
  return loud(tokens[i - 1]) || loud(tokens[i + 1]);
}

export function* matchCompanies(
  text: string,
  matcher: AliasMatcher,
): Generator<{ companyId: number; matched: string }> {
  for (const m of findMentions(text, matcher, { uppercaseContext: true })) {
    if (m.entry.companyId !== null) yield { companyId: m.entry.companyId, matched: m.matched };
  }
}

const MIN_CLAUSE = 20;
const MAX_CLAUSE = 1200;
const SHARE_REACH = 220;
const VERB_REACH = 140;
const MAX_PER_PAIR = 3;

const PREFILTER =
  /customer|client|buyer|supplier|vendor|suppl(?:y|ie|ied)|sell|sold|sales to|export|cater|serv|procur|purchas|sourc|import|buy|bought|licen[cs]|order|contract|award|letter of|revenue|turnover|off-?take/i;
const REJECT =
  /\b(?:compet(?:e|es|ed|ing|itor|itors|ition|itive)|peers?|rivals?|compared (?:to|with)|in comparison|versus|vs\.?|as against|counterparts|market share|other players|players? (?:like|such as)|industry leaders?|benchmark(?:ed|ing)?|similar to|unlike|outperform\w*)\b/i;
const QUESTION_START =
  /^\s*(?:q\s*[:.]|question\s*:|(?:could|can|would|will|should|is|are|do|does|did|what|why|how|when|which|who)\b[^.]*\?)/i;
const US = /\b(?:us|we|our company|the company|ourselves)\b/i;
const RELATED_PARTY = /\brelated part(?:y|ies)\b/i;
const ORDER_CUE =
  /\b(?:orders?|contracts?|LoA|letters? of (?:award|intent|acceptance)|work orders?|purchase orders?|awarded|bagged|won)\b/i;

const PCT = /(\d{1,3}(?:\.\d{1,2})?)\s?(?:%|per\s?cent\b|percent\b)/gi;
const DENOM_PREFIX =
  /^\s*(?:share\s+)?(?:of|in|to)\s+(?:the\s+)?(?:(?:our|its|their|company['’]?s|total|overall|consolidated|standalone|net|gross|annual|group|segment|the)\s+){0,3}/i;
const REVENUE_NOUN =
  /^(?:revenues?|sales|turnover|top\s?line|income from operations|revenue from operations|operating revenue)\b/i;
const PURCHASE_NOUN =
  /^(?:purchases?|procurement|raw materials?(?:\s+(?:purchases?|requirements?|costs?|consumption|sourcing))?|material costs?|cost of materials(?:\s+consumed)?|supplies|sourcing|imports)\b/i;
const REVENUE_BEFORE =
  /(?:revenue|sales|turnover)\s+(?:share|contribution)\s*(?:of|at|was|is|stood at|to)?\s*(?:about|around|approximately|nearly|over|~)?\s*$/i;
const PURCHASE_BEFORE =
  /(?:purchase|procurement|sourcing)\s+(?:share|contribution)\s*(?:of|at|was|is|stood at)?\s*(?:about|around|approximately|nearly|over|~)?\s*$/i;
const COUNT_CONTEXT =
  /\b(?:customer (?:count|base|additions?)|number of (?:customers|clients)|subscribers?|users?|customers? (?:grew|increased|rose|added))\b/i;
const OWNERSHIP_CONTEXT =
  /\b(?:stake|shareholding|equity (?:interest|stake|holding)|holds?|holding|owned|ownership|subsidiary|joint venture|JV|associate)\b/i;

const CUSTOMER_VERB =
  /\b(?:suppl(?:y|ies|ied|ying)(?!\s+chain)|sell(?:s|ing)?|sold|sales\s+to|export(?:s|ed|ing)?|cater(?:s|ed|ing)?\s+to|serv(?:e|es|ed|ing))\b/gi;
const FROM_VERB =
  /\b(?:revenues?\s+from|orders?(?:\s+\w+){0,4}?\s+from|business\s+from|contracts?(?:\s+\w+){0,4}?\s+(?:from|with)|awarded(?:\s+\w+){0,3}?\s+by|LoA\s+from|letters?\s+of\s+(?:award|intent|acceptance)(?:\s+\w+){0,2}?\s+from)\b/gi;
const AWARD_VERB =
  /\b(?:awarded|placed\s+(?:an?\s+)?(?:repeat\s+)?orders?|issued\s+(?:an?\s+)?(?:LoA|order|purchase order|work order))\b/gi;
const SUPPLIER_VERB =
  /\b(?:(?:procur(?:e|es|ed|ing|ement)|purchas(?:e|es|ed|ing)|sourc(?:e|es|ed|ing)|import(?:s|ed|ing)?|buy(?:s|ing)?|bought|licen[cs](?:e|es|ed|ing))(?:\s+[\w-]+){0,3}?\s+from|supplied\s+by)\b/gi;
const CUSTOMER_NOUN = /\b(?:customers?|clients?|buyers?|off-?takers?|key accounts?)\b/i;
const SUPPLIER_NOUN = /\b(?:suppliers?|vendors?|sub-?contractors?|licensors?)\b/i;
const SUPPLIER_TO_BEFORE =
  /\b(?:suppliers?|vendors?|partners?|sub-?contractors?)\s+(?:[\w-]+\s+){0,3}?(?:to|for|of)\s+(?:the\s+)?$/i;
const SUPPLIER_TO_AFTER = /^['’]s?\s+(?:[\w-]+\s+){0,2}?(?:suppliers?|vendors?)\b/i;
const CUSTOMER_OF_BEFORE = /\b(?:customers?|clients?)\s+(?:[\w-]+\s+){0,2}?of\s+(?:the\s+)?$/i;

const BASE_CONFIDENCE: Record<SourceFamily, number> = {
  annual_report: 0.7,
  concall: 0.6,
  screener: 0.5,
  presentation: 0.6,
  rating_rationale: 0.65,
  order_filing: 0.8,
  announcement_metadata: 0.75,
  manual: 0.9,
};

const COST_PATTERNS: Array<[CostBucket, RegExp]> = [
  [
    "RND",
    /\b(?:R&D|research(?: and| &) development|design services|engineering services|technology licen[cs]e|licen[cs]ing|royalt(?:y|ies)|clinical|contract research|CRAMS|CDMO|patents?|know-how)\b/gi,
  ],
  [
    "CAPEX",
    /\b(?:capex|capital (?:goods|equipment|expenditure)|plant(?: and| &) machinery|machinery|equipment|turnkey|EPC|construction|civil works|commissioning|erection|installation|rolling stock|locomotives?|wagons?|coaches|transformers?|turbines?|substations?|transmission lines?|towers?|vessels?|ships?|aircraft|electrification|signalling)\b/gi,
  ],
  [
    "COGS",
    /\b(?:raw materials?|components?|parts|inputs?|steel|aluminium|copper|chemicals?|APIs?|intermediates?|packaging|fuel|coal|crude|feedstock|castings?|forgings?|tyres?|batteries|cells?|semiconductors?|chips?|wires?|cables?|yarn|fabric|pulp|ores?|ingredients?|spares?|consumables)\b/gi,
  ],
  [
    "SGA",
    /\b(?:advertis\w*|marketing|media|IT services|software services|consulting|staffing|manpower|logistics|freight|facility management|housekeeping|security services|insurance|connectivity|outsourc\w*|BPO|payroll|rent(?:al)?|leas(?:e|ing))\b/gi,
  ],
];

export function classifyCostBucket(text: string): CostBucket {
  let best: CostBucket = "UNKNOWN";
  let bestCount = 0;
  for (const [bucket, re] of COST_PATTERNS) {
    const count = [...text.matchAll(re)].length;
    if (count > bestCount) {
      best = bucket;
      bestCount = count;
    }
  }
  return best;
}

interface Share {
  pct: number;
  cls: "revenue_share" | "purchase_share";
  start: number;
}

interface ClauseShares {
  shares: Share[];
  countCue: boolean;
  ownershipCue: boolean;
}

function sharesIn(text: string): ClauseShares {
  const shares: Share[] = [];
  let countCue = false;
  let ownershipCue = false;
  for (const m of text.matchAll(PCT)) {
    const pct = Number(m[1]);
    if (!(pct > 0 && pct <= 100)) continue;
    const end = m.index + m[0].length;
    const after = text.slice(end, end + 80);
    const before = text.slice(Math.max(0, m.index - 50), m.index);
    const prefix = DENOM_PREFIX.exec(after);
    const noun = prefix ? after.slice(prefix[0].length) : null;
    const cls =
      (noun !== null && REVENUE_NOUN.test(noun)) || REVENUE_BEFORE.test(before)
        ? "revenue_share"
        : (noun !== null && PURCHASE_NOUN.test(noun)) || PURCHASE_BEFORE.test(before)
          ? "purchase_share"
          : null;
    if (cls) {
      shares.push({ pct, cls, start: m.index });
      continue;
    }
    const around = text.slice(Math.max(0, m.index - 60), end + 60);
    if (COUNT_CONTEXT.test(around)) countCue = true;
    else if (OWNERSHIP_CONTEXT.test(around)) ownershipCue = true;
  }
  return { shares, countCue, ownershipCue };
}

type Role = "customer" | "supplier";

interface RoleCall {
  role: Role;
  strong: boolean;
}

function verbRole(text: string, start: number, end: number, usAt: readonly number[]): Role | null {
  const candidates: Array<{ role: Role | null; distance: number }> = [];
  const objectIsUs = (from: number) =>
    US.test(text.slice(from, from + 60)) || usAt.some((p) => p >= from && p - from <= 60);
  for (const m of text.matchAll(CUSTOMER_VERB)) {
    const vEnd = m.index + m[0].length;
    if (vEnd <= start) candidates.push({ role: "customer", distance: start - vEnd });
    else if (m.index >= end) {
      candidates.push({ role: objectIsUs(vEnd) ? "supplier" : null, distance: m.index - end });
    }
  }
  for (const m of text.matchAll(FROM_VERB)) {
    const vEnd = m.index + m[0].length;
    if (vEnd <= start) candidates.push({ role: "customer", distance: start - vEnd });
  }
  for (const m of text.matchAll(AWARD_VERB)) {
    if (m.index >= end) candidates.push({ role: "customer", distance: m.index - end });
  }
  for (const m of text.matchAll(SUPPLIER_VERB)) {
    const vEnd = m.index + m[0].length;
    if (vEnd <= start) candidates.push({ role: "supplier", distance: start - vEnd });
    else if (m.index >= end) {
      candidates.push({ role: objectIsUs(vEnd) ? "customer" : null, distance: m.index - end });
    }
  }
  const nearest = candidates
    .filter((c) => c.distance <= VERB_REACH)
    .sort((a, b) => a.distance - b.distance)[0];
  return nearest?.role ?? null;
}

function roleOf(
  text: string,
  start: number,
  end: number,
  share: Share | null,
  usAt: readonly number[],
): RoleCall | null {
  if (share) return { role: share.cls === "revenue_share" ? "customer" : "supplier", strong: true };
  const before = text.slice(Math.max(0, start - 60), start);
  const after = text.slice(end, end + 40);
  if (SUPPLIER_TO_BEFORE.test(before) || SUPPLIER_TO_AFTER.test(after)) {
    return { role: "customer", strong: true };
  }
  if (CUSTOMER_OF_BEFORE.test(before)) return { role: "supplier", strong: true };
  const verb = verbRole(text, start, end, usAt);
  if (verb) return { role: verb, strong: true };
  const customerNoun = CUSTOMER_NOUN.test(text);
  const supplierNoun = SUPPLIER_NOUN.test(text);
  if (customerNoun && !supplierNoun) return { role: "customer", strong: false };
  if (supplierNoun && !customerNoun) return { role: "supplier", strong: false };
  if (!customerNoun && !supplierNoun && ORDER_CUE.test(text)) {
    return { role: "customer", strong: false };
  }
  return null;
}

const QUESTION_FROM =
  /\bquestions?\s+(?:is\s+|comes\s+)?from\s+(?:the\s+line\s+of\s+)?(?:(?:mr|ms|mrs|dr)\.?\s+)?([A-Z][\w'’-]*(?:\s+[A-Z][\w'’-]*){0,3})/;
const SPEAKER = /^\s*([A-Z][\w.'’-]*(?:\s+[A-Z][\w.'’-]*){0,4})\s*:\s/;
const ANALYST_LABEL = /\b(?:analyst|participant|questioner|investor)\b/i;
const MANAGEMENT_LABEL =
  /\b(?:management|moderator|ceo|cfo|cmd|md|chairman|chairperson|director|president|founder|head|officer)\b/i;

class QuestionTracker {
  private readonly analysts = new Set<string>();
  private asking = false;

  update(text: string): boolean {
    const asked = QUESTION_FROM.exec(text);
    if (asked?.[1]) this.analysts.add(asked[1].toLowerCase());
    const speaker = SPEAKER.exec(text)?.[1]?.toLowerCase() ?? null;
    if (speaker !== null) {
      this.asking =
        this.analysts.has(speaker) ||
        (ANALYST_LABEL.test(speaker) && !MANAGEMENT_LABEL.test(speaker));
    } else if (/^\s*(?:q|question)\s*[:.]/i.test(text)) {
      this.asking = true;
    } else if (/^\s*(?:a|answer)\s*[:.]/i.test(text)) {
      this.asking = false;
    }
    return this.asking;
  }
}

export function extractObservations(
  text: string,
  matcher: AliasMatcher,
  opts: ExtractOptions,
): ExtractResult {
  const kept = new Map<string, Observation>();
  let dropped = 0;
  const questions = new QuestionTracker();
  for (const clause of splitClauses(text)) {
    const asking = questions.update(clause.text);
    if (clause.text.length < MIN_CLAUSE || clause.text.length > MAX_CLAUSE) continue;
    if (!PREFILTER.test(clause.text)) continue;
    const mentions = findMentions(clause.text, matcher, { offset: clause.start });
    const others = mentions.filter((m) => !isSelf(m.entry, opts.focal));
    if (!others.length) continue;
    if (asking || QUESTION_START.test(clause.text) || /\?\s*$/.test(clause.text)) {
      dropped += others.length;
      continue;
    }
    if (REJECT.test(clause.text)) {
      dropped += others.length;
      continue;
    }
    const usAt = mentions
      .filter((m) => isSelf(m.entry, opts.focal))
      .map((m) => m.start - clause.start);
    const clauseShares = sharesIn(clause.text);
    const distinct = new Set(others.map((m) => m.entry.counterpartyId));
    for (const mention of others) {
      const obs = observe(clause, mention, matcher, opts, {
        usAt,
        clauseShares,
        single: distinct.size === 1,
      });
      if (!obs) {
        dropped++;
        continue;
      }
      const key = [
        obs.supplier.counterpartyId,
        obs.customer.counterpartyId,
        obs.costBucket,
        obs.valueBasis,
        obs.pct ?? "",
      ].join("|");
      const prior = kept.get(key);
      if (!prior || prior.confidence < obs.confidence) kept.set(key, obs);
    }
  }
  return { observations: capPerPair([...kept.values()]), dropped };
}

function isSelf(entry: AliasEntry, focal: AliasEntry): boolean {
  return (
    entry.counterpartyId === focal.counterpartyId ||
    (entry.companyId !== null && entry.companyId === focal.companyId)
  );
}

export function sameGroup(a: AliasEntry, b: AliasEntry): boolean {
  return a.groupKeys.some((g) => b.groupKeys.includes(g));
}

function observe(
  clause: Clause,
  mention: Mention,
  matcher: AliasMatcher,
  opts: ExtractOptions,
  ctx: { usAt: readonly number[]; clauseShares: ClauseShares; single: boolean },
): Observation | null {
  const other = mention.entry;
  if (sameGroup(other, opts.focal) || other.kind === "group") return null;
  const start = mention.start - clause.start;
  const end = mention.end - clause.start;
  const share = ctx.single ? nearestShare(ctx.clauseShares.shares, start) : null;
  const call = roleOf(clause.text, start, end, share, ctx.usAt);
  if (!call) return null;
  const otherIsCustomer = call.role === "customer";
  const supplier = otherIsCustomer ? opts.focal : other;
  const customer = otherIsCustomer ? other : opts.focal;
  if (matcher.blocks.has(blockKey(supplier.counterpartyId, customer.counterpartyId))) return null;
  const order = !share && otherIsCustomer && ORDER_CUE.test(clause.text);
  const money = order && ctx.single ? (findMoney(clause.text)[0] ?? null) : null;
  const cueClass: CueClass = share
    ? share.cls
    : ctx.clauseShares.countCue
      ? "customer_count"
      : ctx.clauseShares.ownershipCue
        ? "ownership"
        : order
          ? "order"
          : "mention";
  const fiscalYear = fiscalYearIn(clause.text);
  return {
    supplier: party(supplier),
    customer: party(customer),
    disclosedBy: otherIsCustomer ? "supplier" : "customer",
    disclosureKind: RELATED_PARTY.test(clause.text)
      ? "related_party"
      : share
        ? "major_customer"
        : order
          ? "contract"
          : opts.family === "annual_report"
            ? "segment"
            : "press",
    costBucket: classifyCostBucket(clause.text),
    valueBasis: share ? share.cls : money ? "contract_total" : "unknown",
    cueClass,
    pct: share?.pct ?? null,
    valueCr: money?.valueCr ?? null,
    currency: money?.currency ?? null,
    period: fiscalYear === null ? opts.period : { ...fiscalPeriod(fiscalYear), fiscalYear },
    orderStatus: order ? "awarded" : null,
    claim: clause.text.replace(/\s+/g, " ").trim(),
    confidence: confidenceOf(opts.family, {
      share: share !== null,
      strong: call.strong,
      exactCase: mention.exactCase,
      weakCue: cueClass === "customer_count" || cueClass === "ownership",
    }),
    matched: mention.matched,
    newCounterparty: false,
    start: clause.start,
    end: clause.end,
  };
}

function party(entry: Party): Party {
  return { counterpartyId: entry.counterpartyId, companyId: entry.companyId, name: entry.name };
}

function nearestShare(shares: readonly Share[], at: number): Share | null {
  let best: Share | null = null;
  for (const s of shares) {
    const distance = Math.abs(s.start - at);
    if (distance <= SHARE_REACH && (!best || distance < Math.abs(best.start - at))) best = s;
  }
  return best;
}

function confidenceOf(
  family: SourceFamily,
  f: { share: boolean; strong: boolean; exactCase: boolean; weakCue: boolean },
): number {
  let c = BASE_CONFIDENCE[family];
  if (f.share) c += 0.15;
  if (f.strong) c += 0.05;
  if (f.exactCase) c -= 0.1;
  if (f.weakCue) c -= 0.1;
  return Math.round(Math.min(0.95, Math.max(0.3, c)) * 100) / 100;
}

function capPerPair(observations: Observation[]): Observation[] {
  const counts = new Map<string, number>();
  return observations
    .sort((a, b) => b.confidence - a.confidence || a.start - b.start)
    .filter((o) => {
      const pair = blockKey(o.supplier.counterpartyId, o.customer.counterpartyId);
      const n = counts.get(pair) ?? 0;
      counts.set(pair, n + 1);
      return n < MAX_PER_PAIR;
    })
    .sort((a, b) => a.start - b.start);
}

const CONCENTRATION_LINE =
  /(?:no\.?|number) of customers? (?:exceeding|contributing|accounting for|with) (?:more than )?10\s?%[^\n\d]*?(\d+)(?:\s+(\d+))?/i;
const CONCENTRATION_REVENUE =
  /(?:total )?revenue (?:from|of) such customers?\s*\(?(?:inr|rs\.?|₹)?\s*(crore|crores|million|millions|lakhs?|mn|cr)?\.?\)?[^\n\d]*?([\d,]+(?:\.\d+)?)/i;

export function extractConcentration(text: string): ConcentrationDisclosure | null {
  const countMatch = CONCENTRATION_LINE.exec(text);
  if (!countMatch) return null;
  const window = text.slice(countMatch.index, countMatch.index + 600);
  const revMatch = CONCENTRATION_REVENUE.exec(window);
  const unitRaw = revMatch?.[1]?.toLowerCase() ?? null;
  return {
    customersOver10Pct: Number(countMatch[1]),
    revenueFromThem: revMatch ? parseIndianNumber(revMatch[2] as string) : null,
    unit:
      unitRaw == null
        ? null
        : unitRaw.startsWith("cr")
          ? "crore"
          : unitRaw.startsWith("lakh")
            ? "lakh"
            : "million",
  };
}

export interface TopCustomerShare {
  topN: number;
  pct: number;
  sentence: string;
}

const TOP_N =
  /\b(?:top|largest)\s+(\d{1,2})\s+customers?\b[^%]{0,120}?(\d{1,2}(?:\.\d+)?)\s?%|\b(\d{1,2}(?:\.\d+)?)\s?%[^%]{0,80}?\b(?:top|largest)\s+(\d{1,2})\s+customers?\b/gi;

export function extractTopCustomerShares(text: string): TopCustomerShare[] {
  const out: TopCustomerShare[] = [];
  for (const clause of splitClauses(text)) {
    if (clause.text.length > MAX_CLAUSE) continue;
    for (const m of clause.text.matchAll(TOP_N)) {
      const topN = Number(m[1] ?? m[4]);
      const pct = Number(m[2] ?? m[3]);
      if (topN > 0 && topN <= 50 && pct > 0 && pct <= 100)
        out.push({ topN, pct, sentence: clause.text.replace(/\s+/g, " ").trim().slice(0, 400) });
    }
  }
  return out;
}

export function toCrore(value: number, unit: ConcentrationDisclosure["unit"]): number {
  switch (unit) {
    case "million":
      return value / 10;
    case "lakh":
      return value / 100;
    default:
      return value;
  }
}
