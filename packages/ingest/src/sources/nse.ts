import { UpstreamError } from "@ma/core";
import { MARKET_INDICES } from "../data/market-indices.js";
import type { HttpClient, HttpResponse } from "../http.js";
import {
  addDays,
  barRejection,
  type DailyBar,
  type HistoryWindow,
  PriceValidationError,
} from "./yahoo.js";

export interface IndexMember {
  name: string;
  industry: string;
  symbol: string;
  isin: string;
}

export interface NseAnnouncement {
  symbol: string;
  companyName: string;
  subject: string;
  details: string;
  attachmentUrl: string | null;
  publishedAt: Date;
  industry: string | null;
  isin: string | null;
}

export const NSE_INDEX_FILES: Record<string, string> = Object.fromEntries(
  MARKET_INDICES.flatMap((i) => (i.constituentsFile ? [[i.code, i.constituentsFile]] : [])),
);

export function parseIndexCsv(csv: string): IndexMember[] {
  const lines = csv.trim().split(/\r?\n/);
  const header = (lines[0] ?? "").split(",").map((h) => h.trim().toLowerCase());
  const col = (name: string) => header.findIndex((h) => h.startsWith(name));
  const iName = col("company name");
  const iInd = col("industry");
  const iSym = col("symbol");
  const iIsin = col("isin");
  return lines.slice(1).flatMap((line) => {
    const cells = splitCsvLine(line);
    const symbol = cells[iSym]?.trim();
    if (!symbol) return [];
    return [
      {
        name: cells[iName]?.trim() ?? symbol,
        industry: cells[iInd]?.trim() ?? "",
        symbol,
        isin: cells[iIsin]?.trim() ?? "",
      },
    ];
  });
}

interface RawAnnouncement {
  symbol: string;
  sm_name: string;
  desc: string;
  attchmntText: string;
  attchmntFile: string | null;
  an_dt: string;
  smIndustry: string | null;
  sm_isin: string | null;
}

export function parseAnnouncements(json: string): NseAnnouncement[] {
  const rows = JSON.parse(json) as RawAnnouncement[];
  return rows.map((r) => ({
    symbol: r.symbol,
    companyName: r.sm_name,
    subject: r.desc,
    details: r.attchmntText,
    attachmentUrl: r.attchmntFile || null,
    publishedAt: parseNseDate(r.an_dt),
    industry: r.smIndustry || null,
    isin: r.sm_isin || null,
  }));
}

const MONTHS: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

export function parseNseDate(s: string): Date {
  const m = /^(\d{2})-([A-Za-z]{3})-(\d{4})(?: (\d{2}):(\d{2}):(\d{2}))?$/.exec(s.trim());
  if (!m) return new Date(s);
  const [, dd, mon, yyyy, hh = "0", mi = "0", ss = "0"] = m;
  const month = MONTHS[(mon as string).toLowerCase()] ?? 0;
  return new Date(
    Date.UTC(Number(yyyy), month, Number(dd), Number(hh) - 5, Number(mi) - 30, Number(ss)),
  );
}

export const NSE_HISTORY_SOURCES = {
  equity: {
    path: "/api/historical/securityArchives",
    referer: "/report-detail/eq_security",
    maxDays: 31,
    verified: false,
  },
  index: {
    path: "/api/historicalOR/indicesHistory",
    referer: "/reports-indices-historical-index-data",
    maxDays: 90,
    verified: true,
  },
} as const;

export const NSE_INDEX_HISTORY_MAX_ROWS = 70;

export interface NseListing {
  symbol: string;
  name: string;
  series: string;
  listedOn: string | null;
  isin: string;
}

export function nseDay(s: string): string | null {
  const m = /^(\d{2})-([A-Za-z]{3})-(\d{4})$/.exec(s.trim());
  if (!m) return null;
  const month = MONTHS[(m[2] as string).toLowerCase()];
  if (month === undefined) return null;
  return `${m[3]}-${String(month + 1).padStart(2, "0")}-${m[1]}`;
}

const nseParam = (day: string): string =>
  `${day.slice(8, 10)}-${day.slice(5, 7)}-${day.slice(0, 4)}`;

export function parseEquityList(csv: string): NseListing[] {
  const lines = csv.trim().split(/\r?\n/);
  const header = splitCsvLine(lines[0] ?? "").map((h) => h.trim().toLowerCase());
  const col = (name: string) => header.indexOf(name);
  const [iSym, iName, iSeries, iDate, iIsin] = [
    col("symbol"),
    col("name of company"),
    col("series"),
    col("date of listing"),
    col("isin number"),
  ];
  if ([iSym, iName, iSeries, iDate, iIsin].some((i) => i < 0))
    throw new UpstreamError("nse", "unexpected EQUITY_L header");
  return lines.slice(1).flatMap((line) => {
    const c = splitCsvLine(line).map((v) => v.trim());
    const symbol = c[iSym];
    if (!symbol) return [];
    return [
      {
        symbol,
        name: c[iName] ?? symbol,
        series: c[iSeries] ?? "",
        listedOn: nseDay(c[iDate] ?? ""),
        isin: c[iIsin] ?? "",
      },
    ];
  });
}

export function isNseBlocked(res: Pick<HttpResponse, "status" | "text" | "headers">): boolean {
  if (res.status === 403 || res.status === 401) return true;
  const type = res.headers.get("content-type") ?? "";
  return (
    res.status === 200 && (type.includes("text/html") || res.text().trimStart().startsWith("<"))
  );
}

export class NseBlockedError extends UpstreamError {
  constructor(url: string, status: number) {
    super("nse", `blocked (status ${status})`, { url, blocked: true });
  }
}

function json<T>(text: string, what: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new UpstreamError("nse", `non-JSON ${what} response`);
  }
}

const num = (v: unknown): number | null => {
  if (v == null || v === "" || v === "-") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : Number.NaN;
};

function checked(bars: DailyBar[], source: string): DailyBar[] {
  const seen = new Set<string>();
  for (const b of bars) {
    if (seen.has(b.date)) throw new PriceValidationError(source, `duplicate bar ${b.date}`);
    seen.add(b.date);
    const reason = barRejection(b);
    if (reason) throw new PriceValidationError(source, `${reason} on ${b.date}`);
  }
  return bars.sort((a, b) => a.date.localeCompare(b.date));
}

interface RawIndexRow {
  EOD_INDEX_NAME?: string;
  EOD_OPEN_INDEX_VAL?: unknown;
  EOD_HIGH_INDEX_VAL?: unknown;
  EOD_LOW_INDEX_VAL?: unknown;
  EOD_CLOSE_INDEX_VAL?: unknown;
  HIT_TRADED_QTY?: unknown;
  EOD_TIMESTAMP?: string;
}

export function parseIndexHistory(text: string, indexName: string): DailyBar[] {
  const body = json<{ data?: RawIndexRow[] }>(text, "index history");
  if (!Array.isArray(body?.data)) throw new UpstreamError("nse", "index history without data");
  const bars = body.data.map((r) => {
    if ((r.EOD_INDEX_NAME ?? "").toUpperCase() !== indexName.toUpperCase())
      throw new PriceValidationError("nse", `index name mismatch: ${r.EOD_INDEX_NAME}`);
    const date = nseDay(r.EOD_TIMESTAMP ?? "");
    const close = num(r.EOD_CLOSE_INDEX_VAL);
    if (!date || close == null) throw new UpstreamError("nse", "index row without date/close");
    return {
      date,
      open: num(r.EOD_OPEN_INDEX_VAL),
      high: num(r.EOD_HIGH_INDEX_VAL),
      low: num(r.EOD_LOW_INDEX_VAL),
      close,
      adjClose: null,
      volume: num(r.HIT_TRADED_QTY),
    };
  });
  return checked(bars, "nse");
}

interface RawEquityRow {
  CH_SYMBOL?: string;
  CH_SERIES?: string;
  CH_TIMESTAMP?: string;
  CH_OPENING_PRICE?: unknown;
  CH_TRADE_HIGH_PRICE?: unknown;
  CH_TRADE_LOW_PRICE?: unknown;
  CH_CLOSING_PRICE?: unknown;
  CH_TOT_TRADED_QTY?: unknown;
}

export function parseEquityHistory(text: string, symbol: string): DailyBar[] {
  const body = json<{ data?: RawEquityRow[] }>(text, "equity history");
  if (!Array.isArray(body?.data)) throw new UpstreamError("nse", "equity history without data");
  const bars = body.data.flatMap((r) => {
    if (r.CH_SERIES !== "EQ") return [];
    if (r.CH_SYMBOL !== symbol)
      throw new PriceValidationError("nse", `symbol mismatch: ${r.CH_SYMBOL}`);
    const date = /^\d{4}-\d{2}-\d{2}/.exec(r.CH_TIMESTAMP ?? "")?.[0] ?? null;
    const close = num(r.CH_CLOSING_PRICE);
    if (!date || close == null) throw new UpstreamError("nse", "equity row without date/close");
    return [
      {
        date,
        open: num(r.CH_OPENING_PRICE),
        high: num(r.CH_TRADE_HIGH_PRICE),
        low: num(r.CH_TRADE_LOW_PRICE),
        close,
        adjClose: null,
        volume: num(r.CH_TOT_TRADED_QTY),
      },
    ];
  });
  return checked(bars, "nse");
}

export function windowChunks(w: HistoryWindow, maxDays: number): HistoryWindow[] {
  const out: HistoryWindow[] = [];
  for (let from = w.from; from < w.toExclusive; ) {
    const next = addDays(from, maxDays);
    const toExclusive = next < w.toExclusive ? next : w.toExclusive;
    out.push({ from, toExclusive });
    from = toExclusive;
  }
  return out;
}

export class NseSource {
  constructor(
    private readonly http: HttpClient,
    private readonly baseUrl: string,
  ) {}

  async indexMembers(code: keyof typeof NSE_INDEX_FILES | string): Promise<IndexMember[]> {
    const file = NSE_INDEX_FILES[code];
    if (!file) throw new Error(`Unknown NSE index ${code}`);
    const res = await this.http.get(`https://nsearchives.nseindia.com/content/indices/${file}`);
    return parseIndexCsv(res.text());
  }

  async equityListings(): Promise<NseListing[]> {
    const res = await this.http.get(
      "https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv",
    );
    if (isNseBlocked(res)) throw new NseBlockedError("EQUITY_L.csv", res.status);
    return parseEquityList(res.text());
  }

  async indexHistory(
    indexName: string,
    window: HistoryWindow,
    signal?: AbortSignal,
  ): Promise<DailyBar[]> {
    const src = NSE_HISTORY_SOURCES.index;
    const out: DailyBar[] = [];
    for (const w of windowChunks(window, src.maxDays)) {
      signal?.throwIfAborted();
      const url = `${this.baseUrl}${src.path}?indexType=${encodeURIComponent(indexName)}&from=${nseParam(w.from)}&to=${nseParam(addDays(w.toExclusive, -1))}`;
      const text = await this.history(url, src.referer, signal);
      const bars = parseIndexHistory(text, indexName);
      if (bars.length >= NSE_INDEX_HISTORY_MAX_ROWS)
        throw new UpstreamError("nse", "index history page may be truncated", { url });
      out.push(...bars.filter((b) => b.date >= w.from && b.date < w.toExclusive));
    }
    return checked(out, "nse");
  }

  async equityHistory(
    symbol: string,
    window: HistoryWindow,
    signal?: AbortSignal,
  ): Promise<DailyBar[]> {
    const src = NSE_HISTORY_SOURCES.equity;
    const out: DailyBar[] = [];
    for (const w of windowChunks(window, src.maxDays)) {
      signal?.throwIfAborted();
      const url = `${this.baseUrl}${src.path}?from=${nseParam(w.from)}&to=${nseParam(addDays(w.toExclusive, -1))}&symbol=${encodeURIComponent(symbol)}&dataType=priceVolumeDeliverable&series=EQ`;
      const text = await this.history(url, src.referer, signal);
      out.push(
        ...parseEquityHistory(text, symbol).filter(
          (b) => b.date >= w.from && b.date < w.toExclusive,
        ),
      );
    }
    return checked(out, "nse");
  }

  private async history(url: string, referer: string, signal?: AbortSignal): Promise<string> {
    const res = await this.http.get(url, {
      headers: {
        accept: "application/json, text/plain, */*",
        referer: `${this.baseUrl}${referer}`,
      },
      retries: 1,
      ...(signal ? { signal } : {}),
    });
    if (isNseBlocked(res)) throw new NseBlockedError(url, res.status);
    if (res.status !== 200) throw new UpstreamError("nse", `status ${res.status}`, { url });
    return res.text();
  }

  async announcements(symbol: string): Promise<NseAnnouncement[]> {
    const res = await this.http.get(
      `${this.baseUrl}/api/corporate-announcements?index=equities&symbol=${encodeURIComponent(symbol)}`,
      {
        headers: {
          accept: "application/json, text/plain, */*",
          referer: `${this.baseUrl}/companies-listing/corporate-filings-announcements`,
        },
      },
    );
    return parseAnnouncements(res.text());
  }
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (ch === "," && !quoted) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}
