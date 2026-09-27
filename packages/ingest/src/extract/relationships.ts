import { parseIndianNumber } from "@ma/core";

export const RELATIONSHIP_EXTRACTOR_VERSION = 1;

export interface AliasEntry {
  companyId: number;
  name: string;
  aliases: string[];
  symbol?: string | null;
}

export interface ConcentrationDisclosure {
  customersOver10Pct: number;
  revenueFromThem: number | null;
  unit: "crore" | "million" | "lakh" | null;
}

export interface NamedMention {
  companyId: number;
  matchedAlias: string;
  role: "customer" | "supplier" | "unknown";
  pct: number | null;
  sentence: string;
}

const LEGAL_SUFFIX =
  /\s+(?:limited|ltd\.?|ltd|inc\.?|corporation|corp\.?|plc|ag|sa|nv|co\.?|company)\s*$/i;

export function normalizeCompanyName(name: string): string {
  return name
    .replace(/&amp;/g, "&")
    .replace(/[.,'’]/g, "")
    .replace(LEGAL_SUFFIX, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function buildAliasMatcher(entries: AliasEntry[]): AliasMatcher {
  const byAlias = new Map<string, number>();
  const bySymbol = new Map<string, number>();
  for (const e of entries) {
    for (const alias of [e.name, ...e.aliases]) {
      const key = normalizeCompanyName(alias);
      if (key.length >= 4 && !GENERIC.has(key)) byAlias.set(key, e.companyId);
    }
    if (
      e.symbol &&
      e.symbol.length >= 4 &&
      /^[A-Z]+$/.test(e.symbol) &&
      !SYMBOL_STOPLIST.has(e.symbol)
    ) {
      bySymbol.set(e.symbol, e.companyId);
    }
  }
  const sorted = [...byAlias.keys()].sort((a, b) => b.length - a.length);
  return {
    pattern: new RegExp(`\\b(${sorted.map(escapeRegex).join("|")})\\b`, "gi"),
    symbolPattern: bySymbol.size
      ? new RegExp(`\\b(${[...bySymbol.keys()].join("|")})\\b`, "g")
      : null,
    byAlias,
    bySymbol,
  };
}

export interface AliasMatcher {
  pattern: RegExp;
  symbolPattern: RegExp | null;
  byAlias: Map<string, number>;
  bySymbol: Map<string, number>;
}

export function* matchCompanies(
  text: string,
  matcher: AliasMatcher,
): Generator<{ companyId: number; matched: string }> {
  for (const m of text.matchAll(matcher.pattern)) {
    const companyId = matcher.byAlias.get(normalizeCompanyName(m[1] as string));
    if (companyId !== undefined) yield { companyId, matched: m[1] as string };
  }
  if (!matcher.symbolPattern) return;
  for (const m of text.matchAll(matcher.symbolPattern)) {
    const companyId = matcher.bySymbol.get(m[1] as string);
    if (companyId !== undefined) yield { companyId, matched: m[1] as string };
  }
}

const SYMBOL_STOPLIST = new Set([
  "FACT",
  "IDEA",
  "SAIL",
  "TRENT",
  "TITAN",
  "ZOMATO",
  "POWERGRID",
  "MARICO",
  "PAGEIND",
]);

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
]);

const CUSTOMER_CUES =
  /\b(customer|customers|client|clients|sales to|supplies? to|supplied to|revenue from|orders? from|contract (?:with|from)|caters? to)\b/i;
const SUPPLIER_CUES =
  /\b(supplier|suppliers|vendor|vendors|procure[sd]? from|purchases? from|sourced? from|supplied by)\b/i;
const REVENUE_CUE = /\b(revenue|revenues|sales|turnover|top ?line)\b/i;
const PCT = /(\d{1,2}(?:\.\d{1,2})?)\s?%/g;

export function extractNamedMentions(
  text: string,
  matcher: AliasMatcher,
  selfCompanyId: number,
): NamedMention[] {
  const out: NamedMention[] = [];
  const seen = new Set<string>();
  for (const sentence of sentences(text)) {
    if (!REVENUE_CUE.test(sentence)) continue;
    const customerCue = CUSTOMER_CUES.test(sentence);
    const supplierCue = SUPPLIER_CUES.test(sentence);
    if (!customerCue && !supplierCue) continue;
    const pcts = [...sentence.matchAll(PCT)]
      .map((m) => Number(m[1]))
      .filter((p) => p > 0 && p <= 100);
    for (const { companyId, matched } of matchCompanies(sentence, matcher)) {
      if (companyId === selfCompanyId) continue;
      const key = `${companyId}:${sentence.slice(0, 80)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        companyId,
        matchedAlias: matched,
        role:
          customerCue && !supplierCue
            ? "customer"
            : supplierCue && !customerCue
              ? "supplier"
              : "unknown",
        pct: pcts.length === 1 ? (pcts[0] as number) : null,
        sentence: sentence.trim().slice(0, 500),
      });
    }
  }
  return out;
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
  /\b(?:top|largest)\s+(\d{1,2})\s+customers?\b[^.%]{0,120}?(\d{1,2}(?:\.\d+)?)\s?%|\b(\d{1,2}(?:\.\d+)?)\s?%[^.%]{0,80}?\b(?:top|largest)\s+(\d{1,2})\s+customers?\b/gi;

export function extractTopCustomerShares(text: string): TopCustomerShare[] {
  const out: TopCustomerShare[] = [];
  for (const sentence of sentences(text)) {
    for (const m of sentence.matchAll(TOP_N)) {
      const topN = Number(m[1] ?? m[4]);
      const pct = Number(m[2] ?? m[3]);
      if (topN > 0 && topN <= 50 && pct > 0 && pct <= 100)
        out.push({ topN, pct, sentence: sentence.trim().slice(0, 400) });
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

function* sentences(text: string): Generator<string> {
  const normalized = text.replace(/\s+/g, " ");
  const re = /[^.!?]+[.!?]+|[^.!?]+$/g;
  for (const m of normalized.matchAll(re)) {
    const s = m[0];
    if (s.length >= 30 && s.length <= 1200) yield s;
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
