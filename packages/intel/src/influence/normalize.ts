export const PERSON_NORMALIZER_VERSION = 1;

const HONORIFICS = new Set([
  "shri",
  "sri",
  "shree",
  "smt",
  "shrimati",
  "srimati",
  "kumari",
  "km",
  "dr",
  "mr",
  "mrs",
  "ms",
  "miss",
  "mx",
  "prof",
  "late",
  "adv",
  "er",
  "ca",
  "cs",
  "capt",
  "col",
  "gen",
  "lt",
  "justice",
  "hon",
  "honble",
]);

const SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv"]);

export function nameTokens(raw: string): string[] {
  const cleaned = raw
    .normalize("NFKC")
    .replace(/&amp;/gi, "&")
    .replace(/\([^)]*\)/g, " ")
    .toLowerCase()
    .replace(/([a-z])\.(?=[a-z])/g, "$1 ")
    .replace(/[.,'’`"]/g, " ")
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .replace(/-/g, " ");
  const tokens = cleaned.split(/\s+/).filter(Boolean);
  while (tokens.length > 1 && HONORIFICS.has(tokens[0] as string)) tokens.shift();
  while (tokens.length > 1 && SUFFIXES.has(tokens[tokens.length - 1] as string)) tokens.pop();
  return tokens;
}

export function normalizePersonName(raw: string): string {
  return nameTokens(raw).join(" ");
}

export function personNameKey(raw: string): string {
  return [...nameTokens(raw)].sort().join(" ");
}

export function namesCompatible(a: string, b: string): boolean {
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  if (!ta.length || !tb.length) return false;
  if ([...ta].sort().join(" ") === [...tb].sort().join(" ")) return true;
  return (ta.length <= tb.length && covers(ta, tb)) || (tb.length <= ta.length && covers(tb, ta));
}

function covers(short: readonly string[], long: readonly string[]): boolean {
  const pool = [...long];
  let full = 0;
  for (const token of short) {
    const exact = pool.indexOf(token);
    if (exact >= 0) {
      pool.splice(exact, 1);
      if (token.length >= 3) full += 1;
      continue;
    }
    if (token.length !== 1) return false;
    const initial = pool.findIndex((t) => t.startsWith(token));
    if (initial < 0) return false;
    pool.splice(initial, 1);
  }
  return full >= 1;
}

export function normalizeDin(raw: string | number | null | undefined): string | null {
  if (raw == null) return null;
  const digits = String(raw).replace(/\D/g, "");
  if (!digits || digits.length > 8 || /^0+$/.test(digits)) return null;
  return digits.padStart(8, "0");
}
