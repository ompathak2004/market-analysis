export const RATING_RATIONALE_PARSER_VERSION = 1;

export const RATING_AGENCIES = [
  "icra",
  "crisil",
  "care",
  "india_ratings",
  "brickwork",
  "acuite",
  "infomerics",
] as const;
export type RatingAgency = (typeof RATING_AGENCIES)[number];

export type RatingOutlook =
  | "stable"
  | "positive"
  | "negative"
  | "developing"
  | "watch_positive"
  | "watch_negative"
  | "watch_developing";

export interface RatingRationale {
  agency: RatingAgency | null;
  rating: string | null;
  outlook: RatingOutlook | null;
  date: string | null;
  rationale: string;
}

export const RATING_AGENCY_HOSTS: Readonly<Record<string, RatingAgency>> = {
  "www.icra.in": "icra",
  "www.crisilratings.com": "crisil",
  "www.crisil.com": "crisil",
  "www.careratings.com": "care",
  "www.careedge.in": "care",
  "www.indiaratings.co.in": "india_ratings",
};

const SYMBOL_PREFIX: Readonly<Record<RatingAgency, string>> = {
  icra: "\\[ICRA\\]\\s?",
  crisil: "CRISIL\\s",
  care: "CARE\\s",
  india_ratings: "IND\\s",
  brickwork: "BWR\\s",
  acuite: "ACUIT[EÉ]\\s",
  infomerics: "IVR\\s",
};

const AGENCY_NAMES: readonly (readonly [RegExp, RatingAgency])[] = [
  [/\bICRA (?:Limited|Ltd)\b/i, "icra"],
  [/\bCRISIL Ratings\b/i, "crisil"],
  [/\bCARE (?:Ratings|Edge)\b/i, "care"],
  [/\bIndia Ratings (?:and|&) Research\b|\bInd-Ra\b/i, "india_ratings"],
  [/\bBrickwork Ratings\b/i, "brickwork"],
  [/\bAcuit[eé] Ratings\b/i, "acuite"],
  [/\bInfomerics\b/i, "infomerics"],
];

const LONG_TERM = "(?:AAA|AA[+-]?|A[+-]?|BBB[+-]?|BB[+-]?|B[+-]?|C[+-]?|D)";
const SHORT_TERM = "(?:A[1-4]\\+?)";
const SUFFIX = "(?:\\s?\\((?:CE|SO)\\))?";
const END = "(?![A-Za-z0-9+-])";
const OUTLOOK_WORD = "(Stable|Positive|Negative|Developing)";
const WATCH = new RegExp(
  `^[\\s;/,(]*(?:Rating )?Watch (?:with )?${OUTLOOK_WORD}(?: Implications)?`,
  "i",
);
const NEAR_OUTLOOK = new RegExp(`^\\s*[/;,(]\\s*(?:Outlook\\s*:?\\s*)?${OUTLOOK_WORD}\\b`, "i");
const STATED_OUTLOOK = new RegExp(
  `\\bOutlook(?: is| has been| remains)?(?: revised to| maintained at| retained at)?\\s*[:\\-–]?\\s*['‘]?${OUTLOOK_WORD}\\b`,
  "i",
);

const MONTHS = "janfebmaraprmayjunjulaugsepoctnovdec";
const MONTH = "(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\\.?";
type DateParts = (m: RegExpExecArray) => [number, number, number];
const DATE_FORMATS: readonly (readonly [RegExp, DateParts])[] = [
  [
    new RegExp(`\\b${MONTH}\\s+(\\d{1,2}),?\\s+(\\d{4})\\b`, "i"),
    (m) => [Number(m[3]), mon(m[1] ?? ""), Number(m[2])],
  ],
  [
    new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?[\\s-]+${MONTH}[\\s,-]+(\\d{4})\\b`, "i"),
    (m) => [Number(m[3]), mon(m[2] ?? ""), Number(m[1])],
  ],
  [/\b(\d{1,2})[./-](\d{1,2})[./-](\d{4})\b/, (m) => [Number(m[3]), Number(m[2]), Number(m[1])]],
];
const DATE_WINDOW = 1_500;

const KEEP_HEADING =
  "(?:detailed )?rationale(?: and key rating drivers)?|key rating drivers(?: (?:and|&) (?:their |detailed )?description)?|credit (?:strengths|challenges|weaknesses)|key (?:strengths|weaknesses|rating strengths|rating weaknesses)|strengths|weaknesses|business profile|about the (?:company|entity|issuer)(?: and industry)?|company profile";
const STOP_HEADING =
  "liquidity(?: position)?|rating sensitivit(?:y|ies)(?: factors)?|analytical approach|applicable criteria|links to applicable criteria|outlook|environment(?:al)?(?:,)? (?:and )?social|esg|key financial indicators|status of non-cooperation|any other information|rating history|complexity level|detailed explanation of covenants|annexure|analyst contacts?|media contacts?|contact us|disclaimer|note on complexity|lender details|about (?:icra|crisil|care|india ratings)|summary of rating action|rating action|instrument details";
const HEADING = new RegExp(
  `^[ \\t]*(?:\\d{1,2}[.)][ \\t]*)?(${KEEP_HEADING}|${STOP_HEADING})[ \\t]*(?:[:\\-–—][^\\n]{0,80})?[ \\t\\r]*$`,
  "gim",
);
const KEEP = new RegExp(`^(?:${KEEP_HEADING})$`, "i");

export interface TextSpan {
  start: number;
  end: number;
}

function mon(name: string): number {
  return MONTHS.indexOf(name.slice(0, 3).toLowerCase()) / 3 + 1;
}

export function ratingAgencyOfUrl(url: string): RatingAgency | null {
  try {
    return RATING_AGENCY_HOSTS[new URL(url).hostname.toLowerCase()] ?? null;
  } catch {
    return null;
  }
}

export function ratingDocumentUrl(url: string): string {
  const icra = /^https?:\/\/www\.icra\.in\/Rationale\/ShowRationaleReport\/?\?Id=(\d+)/i.exec(url);
  return icra ? `https://www.icra.in/Rating/ShowRationalReportFilePdfViewer/${icra[1]}` : url;
}

export function ratingLinksIn(text: string | null): string[] {
  if (!text) return [];
  const links = new Set<string>();
  for (const m of text.matchAll(/https?:\/\/[^\s"'<>)\]]+/gi)) {
    const url = m[0].replace(/[.,;]+$/, "");
    if (ratingAgencyOfUrl(url)) links.add(ratingDocumentUrl(url));
  }
  return [...links];
}

function symbolPattern(agency: RatingAgency, scale: string): RegExp {
  return new RegExp(`(?<![A-Za-z])${SYMBOL_PREFIX[agency]}(${scale})${SUFFIX}${END}`, "g");
}

function firstSymbol(
  text: string,
  agencies: readonly RatingAgency[],
  scale: string,
): { agency: RatingAgency; rating: string; end: number; at: number } | null {
  let best: { agency: RatingAgency; rating: string; end: number; at: number } | null = null;
  for (const agency of agencies) {
    const m = symbolPattern(agency, scale).exec(text);
    if (m && (!best || m.index < best.at)) {
      best = { agency, rating: m[0].trim(), end: m.index + m[0].length, at: m.index };
    }
  }
  return best;
}

function agencyByName(text: string): RatingAgency | null {
  let best: { agency: RatingAgency; at: number } | null = null;
  for (const [re, agency] of AGENCY_NAMES) {
    const m = re.exec(text);
    if (m && (!best || m.index < best.at)) best = { agency, at: m.index };
  }
  return best?.agency ?? null;
}

function outlookOf(text: string, after: number | null): RatingOutlook | null {
  if (after !== null) {
    const tail = text.slice(after, after + 60);
    const watch = WATCH.exec(tail);
    if (watch) return `watch_${(watch[1] as string).toLowerCase()}` as RatingOutlook;
    const near = NEAR_OUTLOOK.exec(tail);
    if (near) return (near[1] as string).toLowerCase() as RatingOutlook;
  }
  const stated = STATED_OUTLOOK.exec(text);
  return stated ? ((stated[1] as string).toLowerCase() as RatingOutlook) : null;
}

export function ratingDate(text: string): string | null {
  const head = text.slice(0, DATE_WINDOW);
  let best: { at: number; iso: string } | null = null;
  for (const [re, parts] of DATE_FORMATS) {
    const m = re.exec(head);
    if (!m) continue;
    const [y, mo, d] = parts(m);
    if (y < 1990 || y > 2100 || mo < 1 || mo > 12) continue;
    if (new Date(Date.UTC(y, mo - 1, d)).getUTCDate() !== d) continue;
    const iso = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    if (!best || m.index < best.at) best = { at: m.index, iso };
  }
  return best?.iso ?? null;
}

export function rationaleSpans(text: string): TextSpan[] {
  const headings = [...text.matchAll(HEADING)].map((m) => ({
    at: m.index,
    keep: KEEP.test((m[1] as string).trim()),
  }));
  const spans: TextSpan[] = [];
  for (const [i, h] of headings.entries()) {
    if (!h.keep) continue;
    const end = headings[i + 1]?.at ?? text.length;
    const last = spans.at(-1);
    if (last && last.end === h.at) last.end = end;
    else spans.push({ start: h.at, end });
  }
  return spans.length ? spans : [{ start: 0, end: text.length }];
}

export function maskOutsideRationale(text: string): string {
  let out = "";
  let pos = 0;
  for (const s of rationaleSpans(text)) {
    out += text.slice(pos, s.start).replace(/[^\n]/g, " ") + text.slice(s.start, s.end);
    pos = s.end;
  }
  return out + text.slice(pos).replace(/[^\n]/g, " ");
}

export function parseRatingRationale(text: string, url?: string): RatingRationale {
  const hinted = url ? ratingAgencyOfUrl(url) : null;
  const symbol =
    (hinted
      ? (firstSymbol(text, [hinted], LONG_TERM) ?? firstSymbol(text, [hinted], SHORT_TERM))
      : null) ??
    firstSymbol(text, RATING_AGENCIES, LONG_TERM) ??
    firstSymbol(text, RATING_AGENCIES, SHORT_TERM);
  const rationale = rationaleSpans(text)
    .map((s) => text.slice(s.start, s.end).trim())
    .join("\n\n");
  return {
    agency: hinted ?? symbol?.agency ?? agencyByName(text),
    rating: symbol?.rating.replace(/\s+/g, " ") ?? null,
    outlook: outlookOf(text, symbol?.end ?? null),
    date: ratingDate(text),
    rationale,
  };
}

export function ratingLabel(parsed: RatingRationale, subject: string): string {
  const head = [parsed.agency, parsed.rating, parsed.outlook].filter(Boolean).join(" ");
  return (head ? `${head}: ${subject}` : subject).slice(0, 300);
}
