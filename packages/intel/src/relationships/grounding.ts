import { findMoney, type Money, normalizeCompanyName } from "@ma/ingest";
import { extractTokens, isGrounded } from "../insights/validate.js";
import type { RelationshipClaim } from "./schemas.js";
import type { Section } from "./sections.js";

export interface Span {
  start: number;
  end: number;
}

export const MIN_QUOTE_CHARS = 20;
export const MAX_QUOTE_CHARS = 600;

const FOLD: Readonly<Record<string, string>> = {
  "\u2018": "'",
  "\u2019": "'",
  "\u201a": "'",
  "\u201c": '"',
  "\u201d": '"',
  "\u2010": "-",
  "\u2011": "-",
  "\u2012": "-",
  "\u2013": "-",
  "\u2014": "-",
  "\u20b9": "rs",
};

function fold(ch: string): string {
  if (/\s/.test(ch)) return " ";
  const mapped = FOLD[ch];
  if (mapped !== undefined) return mapped;
  const lower = ch.toLowerCase();
  return lower.length === 1 ? lower : ch;
}

interface Folded {
  text: string;
  offsets: number[];
}

function foldRange(text: string, from: number, to: number): Folded {
  const parts: string[] = [];
  const offsets: number[] = [];
  let space = true;
  for (let i = from; i < to; i++) {
    const c = fold(text[i] as string);
    if (c === " ") {
      if (space) continue;
      space = true;
    } else {
      space = false;
    }
    for (const unit of c) {
      parts.push(unit);
      offsets.push(i);
    }
  }
  return { text: parts.join(""), offsets };
}

export function foldText(text: string): string {
  return foldRange(text, 0, text.length).text.trim();
}

function cleanQuote(quote: string): string {
  return foldText(
    quote.replace(/^[\s"'\u2018\u2019\u201c\u201d]+|[\s"'\u2018\u2019\u201c\u201d]+$/g, ""),
  );
}

export function locateQuote(text: string, quote: string, from = 0, to = text.length): Span | null {
  const needle = cleanQuote(quote);
  if (needle.length < MIN_QUOTE_CHARS || needle.length > MAX_QUOTE_CHARS) return null;
  const hay = foldRange(text, Math.max(0, from), Math.min(text.length, to));
  const at = hay.text.indexOf(needle);
  if (at < 0) return null;
  const start = hay.offsets[at] as number;
  const end = (hay.offsets[at + needle.length - 1] as number) + 1;
  return { start, end };
}

export function namesCounterparty(quote: string, name: string): boolean {
  const folded = foldText(name);
  if (folded.length >= 3 && foldText(quote).includes(folded)) return true;
  const normalized = normalizeCompanyName(name);
  if (normalized.length < 3) return false;
  return ` ${normalizeCompanyName(quote)} `.includes(` ${normalized} `);
}

export function pctGrounded(quote: string, pct: number): boolean {
  const pool = extractTokens(quote)
    .filter((t) => t.unit === "pct")
    .map((t) => ({ value: t.value, unit: t.unit }));
  const decimals = (String(pct).split(".")[1] ?? "").length;
  return isGrounded({ value: pct, signed: false, decimals, unit: "pct" }, pool, false);
}

function moneyIn(quote: string, amount: string): Money | null {
  const parsed = findMoney(amount)[0] ?? null;
  if (!parsed) return null;
  const inQuote = findMoney(quote).some(
    (m) => m.currency === parsed.currency && Math.abs(m.valueCr - parsed.valueCr) < 0.01,
  );
  return inQuote ? parsed : null;
}

export type GroundingFailure =
  | "unknown_section"
  | "quote_not_found"
  | "counterparty_not_quoted"
  | "pct_not_quoted"
  | "amount_not_quoted";

export interface GroundedClaim {
  claim: RelationshipClaim;
  quote: string;
  start: number;
  end: number;
  pct: number | null;
  money: Money | null;
}

export function groundClaim(
  claim: RelationshipClaim,
  sections: readonly Section[],
  text: string,
): GroundedClaim | GroundingFailure {
  const section = sections.find((s) => s.evidenceId === claim.evidenceId);
  if (!section) return "unknown_section";
  const span = locateQuote(text, claim.quote, section.start, section.end);
  if (!span) return "quote_not_found";
  const quote = text.slice(span.start, span.end).replace(/\s+/g, " ").trim();
  if (!namesCounterparty(quote, claim.counterparty)) return "counterparty_not_quoted";
  const pct = claim.pct;
  if (pct !== null && (!(pct > 0 && pct <= 100) || !pctGrounded(quote, pct))) {
    return "pct_not_quoted";
  }
  let money: Money | null = null;
  if (claim.amount?.trim()) {
    if (!foldText(quote).includes(foldText(claim.amount))) return "amount_not_quoted";
    money = moneyIn(quote, claim.amount);
  }
  return { claim, quote, start: span.start, end: span.end, pct, money };
}
