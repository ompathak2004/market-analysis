import { UpstreamError } from "@ma/core";
import type { HttpClient } from "../http.js";
import { isNseBlocked, NseBlockedError, nseDay, parseNseDate } from "./nse.js";

export interface XbrlFact {
  value: string;
  unit: string | null;
  decimals: string | null;
}

export type XbrlContexts = Map<string, Map<string, XbrlFact>>;

const FACT =
  /<([A-Za-z][\w.-]*):([A-Za-z][\w]*)\s+([^>]*?contextRef="([^"]+)"[^>]*?)(?:\/>|>([\s\S]*?)<\/\1:\2>)/g;
const ATTR = (attrs: string, name: string): string | null =>
  new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1] ?? null;

export function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&amp;/g, "&");
}

export function xbrlContexts(xml: string): XbrlContexts {
  if (!/<(?:xbrli:)?xbrl[\s>]/.test(xml)) throw new UpstreamError("nse", "not an XBRL instance");
  const out: XbrlContexts = new Map();
  for (const m of xml.matchAll(FACT)) {
    const prefix = m[1] as string;
    if (prefix === "xbrli" || prefix === "link" || prefix === "xbrldi") continue;
    const attrs = m[3] as string;
    const context = m[4] as string;
    const value = decodeXml(m[5] ?? "")
      .replace(/\s+/g, " ")
      .trim();
    let facts = out.get(context);
    if (!facts) {
      facts = new Map();
      out.set(context, facts);
    }
    facts.set(m[2] as string, {
      value,
      unit: ATTR(attrs, "unitRef"),
      decimals: ATTR(attrs, "decimals"),
    });
  }
  return out;
}

export function factOf(
  contexts: XbrlContexts,
  ids: readonly string[],
  name: string,
): string | null {
  for (const id of ids) {
    const v = contexts.get(id)?.get(name)?.value;
    if (v != null && v !== "") return v;
  }
  return null;
}

export function headerFact(contexts: XbrlContexts, name: string): string | null {
  return factOf(contexts, ["MainI", "MainD", "OneI", "OneD"], name);
}

export function contextGroups(contexts: XbrlContexts, base: string): Map<number, string[]> {
  const pattern = new RegExp(`^(?:D_|I_)?${base}(\\d+)$`);
  const groups = new Map<number, string[]>();
  for (const id of contexts.keys()) {
    const m = pattern.exec(id);
    if (!m) continue;
    const n = Number(m[1]);
    const ids = groups.get(n) ?? [];
    ids.push(id);
    groups.set(n, ids);
  }
  return new Map([...groups.entries()].sort((a, b) => a[0] - b[0]));
}

export function isoDay(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const nse = /^(\d{2})-([A-Za-z]{3})-(\d{4})/.exec(s);
  if (nse) return nseDay(`${nse[1]}-${nse[2]}-${nse[3]}`);
  return null;
}

export function nseTimestamp(raw: unknown): Date | null {
  if (typeof raw !== "string" || !raw.trim() || raw.trim() === "-") return null;
  const s = raw.trim();
  const short = /^(\d{2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2})$/.exec(s);
  const d = parseNseDate(short ? `${s}:00` : s);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function str(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s && s !== "-" && s.toLowerCase() !== "null" ? s : null;
}

export function jsonRows(text: string, what: string): Record<string, unknown>[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new UpstreamError("nse", `non-JSON ${what} response`);
  }
  const rows = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { data?: unknown }).data)
      ? (parsed as { data: unknown[] }).data
      : null;
  if (!rows) throw new UpstreamError("nse", `unexpected ${what} shape`);
  return rows.filter((r): r is Record<string, unknown> => !!r && typeof r === "object");
}

export interface NseRequest {
  http: HttpClient;
  baseUrl: string;
  referer: string;
}

export async function nseGet(
  req: NseRequest,
  url: string,
  signal?: AbortSignal,
  accept = "application/json, text/plain, */*",
): Promise<string> {
  const res = await req.http.get(url, {
    headers: { accept, referer: `${req.baseUrl}${req.referer}` },
    retries: 1,
    ...(signal ? { signal } : {}),
  });
  const blocked = accept.includes("json")
    ? isNseBlocked(res)
    : res.status === 401 ||
      res.status === 403 ||
      (res.headers.get("content-type") ?? "").includes("text/html");
  if (blocked) throw new NseBlockedError(url, res.status);
  if (res.status !== 200) throw new UpstreamError("nse", `status ${res.status}`, { url });
  return res.text();
}

export interface IntegratedFiling {
  seqId: string;
  symbol: string;
  companyName: string;
  type: string;
  periodEnd: string;
  submittedAt: Date | null;
  standalone: boolean | null;
  revised: boolean;
  xbrlUrl: string;
}

export const INTEGRATED_GOVERNANCE = "Integrated Filing- Governance";
export const INTEGRATED_FINANCIALS = "Integrated Filing- Financials";

export function parseIntegratedFilings(json: string): IntegratedFiling[] {
  return jsonRows(json, "integrated filing").flatMap((r) => {
    const xbrlUrl = str(r.xbrl);
    const periodEnd = isoDay(str(r.qe_Date));
    const symbol = str(r.symbol);
    if (!xbrlUrl || !/^https?:\/\//.test(xbrlUrl) || !periodEnd || !symbol) return [];
    const nature = str(r.consolidated)?.toLowerCase() ?? null;
    return [
      {
        seqId: str(r.seq_Id) ?? xbrlUrl,
        symbol,
        companyName: str(r.cmName) ?? str(r.smName) ?? symbol,
        type: str(r.type) ?? "",
        periodEnd,
        submittedAt: nseTimestamp(r.broadcast_Date) ?? nseTimestamp(r.creation_Date),
        standalone: nature === null ? null : nature.startsWith("standalone"),
        revised: Boolean(str(r.revised_Date)) || /revis/i.test(str(r.type_Sub) ?? ""),
        xbrlUrl,
      },
    ];
  });
}

export function integratedFilingsUrl(baseUrl: string, symbol: string, type: string): string {
  return `${baseUrl}/api/integrated-filing-results?index=equities&symbol=${encodeURIComponent(symbol)}&type=${encodeURIComponent(type)}`;
}

export function latestFirst<T extends { periodEnd: string; submittedAt: Date | null }>(
  rows: readonly T[],
): T[] {
  return [...rows].sort(
    (a, b) =>
      b.periodEnd.localeCompare(a.periodEnd) ||
      (b.submittedAt?.getTime() ?? 0) - (a.submittedAt?.getTime() ?? 0),
  );
}

export function inrToCrore(fact: XbrlFact | undefined): number | null {
  if (!fact?.value) return null;
  const n = Number(fact.value.replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  if (fact.unit && fact.unit.toUpperCase() !== "INR") return null;
  return Math.round((n / 1e7) * 100) / 100;
}
