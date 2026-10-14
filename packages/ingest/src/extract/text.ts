export interface Token {
  key: string;
  raw: string;
  start: number;
  end: number;
}

export interface Clause {
  text: string;
  start: number;
  end: number;
}

export interface Money {
  amount: number;
  currency: "INR" | "USD" | "EUR";
  valueCr: number;
  start: number;
  end: number;
}

const TOKEN = /[\p{L}\p{N}]+(?:['’][\p{L}]+)*|&/gu;

export function tokenize(text: string, offset = 0): Token[] {
  const out: Token[] = [];
  for (const m of text.matchAll(TOKEN)) {
    const raw = m[0];
    const start = offset + m.index;
    out.push({ key: raw.toLowerCase().replace(/['’]/g, ""), raw, start, end: start + raw.length });
  }
  return out;
}

const ABBREVIATIONS = new Set([
  "ltd",
  "pvt",
  "co",
  "inc",
  "no",
  "nos",
  "rs",
  "mr",
  "mrs",
  "ms",
  "dr",
  "st",
  "vs",
  "viz",
  "approx",
  "corp",
  "bros",
  "govt",
  "dept",
  "sr",
  "jr",
  "fig",
  "ie",
  "eg",
  "ref",
  "mfg",
  "intl",
]);

const BOUNDARY =
  /[.!?;](?=["'’”)\]]*(?:\s|$))|\n[ \t]*\n\s*|\n(?=[ \t]*[A-Z][\w.'’ ]{1,48}:\s)|,\s*(?=(?:while|whereas|but|however)\b)/g;

export function splitClauses(text: string): Clause[] {
  const out: Clause[] = [];
  let from = 0;
  for (const m of text.matchAll(BOUNDARY)) {
    const i = m.index;
    const mark = m[0][0] as string;
    const terminal = mark === "." || mark === "!" || mark === "?" || mark === ";";
    if (mark === "." && isAbbreviation(text, i)) continue;
    pushClause(out, text, from, terminal ? i + 1 : i);
    from = i + m[0].length;
  }
  pushClause(out, text, from, text.length);
  return out;
}

function isAbbreviation(text: string, dot: number): boolean {
  const word = /([A-Za-z]+)$/.exec(text.slice(Math.max(0, dot - 12), dot))?.[1];
  if (!word) return false;
  return word.length === 1 || ABBREVIATIONS.has(word.toLowerCase());
}

function pushClause(out: Clause[], text: string, start: number, end: number): void {
  let s = start;
  let e = end;
  while (s < e && /\s/.test(text[s] as string)) s++;
  while (e > s && /\s/.test(text[e - 1] as string)) e--;
  if (e > s) out.push({ text: text.slice(s, e), start: s, end: e });
}

const BLOCK_TAG = /^<\/?(?:p|div|li|br|tr|td|th|h\d|section|article|ul|ol|table|header|footer)\b/i;

export function maskMarkup(text: string): string {
  return text
    .replace(/<(script|style|svg)\b[\s\S]*?<\/\1>/gi, blank)
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/<[^>]*>/g, (tag) =>
      BLOCK_TAG.test(tag) ? `\n\n${" ".repeat(tag.length - 2)}` : blank(tag),
    )
    .replace(/&amp;/gi, "&    ")
    .replace(/&#?\w+;/g, blank);
}

function blank(s: string): string {
  return " ".repeat(s.length);
}

export function looksLikeMarkup(text: string, contentType: string | null): boolean {
  if (contentType?.includes("html")) return true;
  return /^\s*<(?:!doctype|html|head|body|div)\b/i.test(text.slice(0, 200));
}

const MONEY =
  /(₹|Rs\.?|INR|USD|US\$|\$|EUR|€)?\s*(\d[\d,]*(?:\.\d+)?)\s*(crores?|cr\.?|lakhs?|lacs?|million|mn|billion|bn)?(?![\p{L}\d])/giu;

const UNIT_TO_CRORE: Record<string, number> = {
  crore: 1,
  cr: 1,
  lakh: 0.01,
  lac: 0.01,
  million: 0.1,
  mn: 0.1,
  billion: 100,
  bn: 100,
};

export function findMoney(text: string, offset = 0): Money[] {
  const out: Money[] = [];
  for (const m of text.matchAll(MONEY)) {
    const symbol = m[1] ?? null;
    const unitRaw = m[3]?.toLowerCase().replace(/\.$/, "").replace(/s$/, "") ?? null;
    const amount = Number((m[2] as string).replace(/,/g, ""));
    if (!Number.isFinite(amount) || amount <= 0) continue;
    if (!symbol && !unitRaw) continue;
    const currency = currencyOf(symbol);
    let valueCr: number;
    if (unitRaw) valueCr = amount * (UNIT_TO_CRORE[unitRaw] ?? 1);
    else if (amount >= 100_000) valueCr = amount / 10_000_000;
    else continue;
    const lead = m[0].length - m[0].trimStart().length;
    const start = offset + m.index + lead;
    out.push({
      amount,
      currency,
      valueCr: Math.round(valueCr * 100) / 100,
      start,
      end: offset + m.index + m[0].length,
    });
  }
  return out;
}

function currencyOf(symbol: string | null): Money["currency"] {
  if (!symbol) return "INR";
  const s = symbol.toUpperCase();
  if (s === "USD" || s === "US$" || s === "$") return "USD";
  if (s === "EUR" || s === "€") return "EUR";
  return "INR";
}

const FY_SHORT = /\bFY\s?'?(\d{4}|\d{2})\b/i;
const FY_RANGE = /\b(?:financial|fiscal) year\s+(20\d{2})\s*[-–/]\s*(\d{2,4})\b/i;

export function fiscalYearIn(text: string): number | null {
  const range = FY_RANGE.exec(text);
  if (range) {
    const end = Number(range[2]);
    return end < 100 ? 2000 + end : end;
  }
  const short = FY_SHORT.exec(text);
  if (!short) return null;
  const n = Number(short[1]);
  return n < 100 ? 2000 + n : n;
}

export function fiscalPeriod(fiscalYear: number): { start: string; end: string } {
  return { start: `${fiscalYear - 1}-04-01`, end: `${fiscalYear}-03-31` };
}

const DURATION = /(\d{1,3})\s*(?:\(\s*[a-z -]+\s*\)\s*)?(months?|years?)\b/gi;
const DURATION_CUE =
  /\b(?:execut\w*|complet\w*|period|within|over|tenure|duration|span|timeline)\b/i;

export function executionMonths(text: string): number | null {
  for (const m of text.matchAll(DURATION)) {
    const before = text.slice(Math.max(0, m.index - 48), m.index);
    if (!DURATION_CUE.test(before)) continue;
    const n = Number(m[1]);
    const months = (m[2] as string).toLowerCase().startsWith("year") ? n * 12 : n;
    if (months > 0 && months <= 240) return months;
  }
  return null;
}
