import { UpstreamError } from "@ma/core";
import { type ParsedPdf, pageOf, pdfToText } from "../documents.js";
import type { HttpClient } from "../http.js";
import { monthNumber } from "./policy-doc.js";

export const ECI_BONDS_PARSER_VERSION = 1;
export const ECI_BONDS_PAGE_URL = "https://www.eci.gov.in/disclosure-of-electoral-bonds";

export type BondKind = "purchase" | "redemption";

export interface BondRow {
  kind: BondKind;
  prefix: string;
  number: number;
  denomination: number;
  date: string;
  name: string;
  page: number | null;
  start: number;
  end: number;
}

export interface BondMatch<T extends BondRow = BondRow> {
  purchase: T;
  redemption: T;
}

export interface BondMatchResult<T extends BondRow = BondRow> {
  pairs: BondMatch<T>[];
  ambiguous: string[];
  unmatchedPurchases: number;
  unmatchedRedemptions: number;
}

const DAY = String.raw`(\d{1,2}\/[A-Za-z]{3}\/\d{4})`;
const NAME = String.raw`(\S(?:(?!\d{1,2}\/[A-Za-z]{3}\/\d{4})[\s\S]){0,200}?)`;
const BOND = String.raw`([A-Z]{2})\s+(\d{1,8})\s+(1,000|10,000|1,00,000|10,00,000|1,00,00,000)`;
const PURCHASE = new RegExp(
  String.raw`(?<=^|\s)\d{1,6}\s+\d{15,30}\s+${DAY}\s+${DAY}\s+${DAY}\s+${NAME}\s+${BOND}\s+\d{3,6}\s+\d{3,10}\s+[A-Za-z]+`,
  "g",
);
const REDEMPTION = new RegExp(
  String.raw`(?<=^|\s)\d{1,6}\s+${DAY}\s+${NAME}\s+\*+\d{2,6}\s+${BOND}\s+\d{3,6}\s+\d{3,10}(?=\s|$)`,
  "g",
);

function isoDay(raw: string): string | null {
  const [d, mon, y] = raw.split("/");
  const month = monthNumber(mon ?? "");
  if (!d || !month || !y) return null;
  return `${y}-${String(month).padStart(2, "0")}-${d.padStart(2, "0")}`;
}

const clean = (s: string) => s.replace(/\s+/g, " ").trim();

export function parseBondRows(pdf: ParsedPdf, kind: BondKind): BondRow[] {
  const out: BondRow[] = [];
  const re = new RegExp(kind === "purchase" ? PURCHASE : REDEMPTION);
  for (const m of pdf.text.matchAll(re)) {
    const g = kind === "purchase" ? [m[2], m[4], m[5], m[6], m[7]] : [m[1], m[2], m[3], m[4], m[5]];
    const [day, name, prefix, number, denomination] = g;
    const date = isoDay(day ?? "");
    const label = clean(name ?? "");
    if (!date || !label || !prefix || !number || !denomination) continue;
    const start = m.index ?? 0;
    out.push({
      kind,
      prefix,
      number: Number(number),
      denomination: Number(denomination.replace(/,/g, "")),
      date,
      name: label,
      page: pageOf(pdf.pageMap, start),
      start,
      end: start + m[0].length,
    });
  }
  return out;
}

export const bondKey = (r: Pick<BondRow, "prefix" | "number" | "denomination">) =>
  `${r.prefix}:${r.number}:${r.denomination}`;

export function matchBonds<T extends BondRow>(
  purchases: readonly T[],
  redemptions: readonly T[],
): BondMatchResult<T> {
  const group = (rows: readonly T[]) => {
    const m = new Map<string, T[]>();
    for (const r of rows) m.set(bondKey(r), [...(m.get(bondKey(r)) ?? []), r]);
    return m;
  };
  const bought = group(purchases);
  const redeemed = group(redemptions);
  const pairs: BondMatch<T>[] = [];
  const ambiguous: string[] = [];
  for (const [key, ps] of bought) {
    const rs = redeemed.get(key);
    if (!rs) continue;
    const [purchase] = ps;
    const [redemption] = rs;
    if (ps.length !== 1 || rs.length !== 1 || !purchase || !redemption) {
      ambiguous.push(key);
      continue;
    }
    pairs.push({ purchase, redemption });
  }
  return {
    pairs,
    ambiguous: ambiguous.sort(),
    unmatchedPurchases: purchases.length - pairs.length,
    unmatchedRedemptions: redemptions.length - pairs.length,
  };
}

export class EciBondsSource {
  constructor(private readonly http: HttpClient) {}

  async document(url: string, signal?: AbortSignal): Promise<ParsedPdf> {
    const res = await this.http.get(url, {
      headers: { accept: "application/pdf" },
      timeoutMs: 300_000,
      ...(signal ? { signal } : {}),
    });
    if (res.status !== 200) throw new UpstreamError("eci", `status ${res.status}`, { url });
    const parsed = await pdfToText(res.body);
    return { text: parsed.text.replaceAll("\u0000", " "), pageMap: parsed.pageMap };
  }
}
