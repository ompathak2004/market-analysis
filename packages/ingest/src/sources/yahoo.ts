import { AppError, sha256, UpstreamError } from "@ma/core";
import type { HttpClient } from "../http.js";

export interface DailyBar {
  date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number;
  adjClose: number | null;
  volume: number | null;
}

export interface Quote {
  symbol: string;
  price: number;
  previousClose: number | null;
  change: number | null;
  changePct: number | null;
  currency: string;
  marketTime: Date;
  marketState: string | null;
}

export type YahooRange = "5d" | "1mo" | "3mo" | "6mo" | "1y" | "2y" | "5y" | "max";

export type InstrumentType = "EQUITY" | "INDEX";

export interface YahooMeta {
  symbol: string;
  currency: string;
  exchange: string;
  instrumentType: string;
  timezone: string;
  gmtOffsetSeconds: number;
  firstTradeDate: string | null;
}

export interface YahooEvent {
  type: "split" | "dividend";
  exDate: string;
  eventKey: string;
  numerator: number | null;
  denominator: number | null;
  cashAmount: number | null;
  currency: string | null;
}

export type BarRejection =
  | "nonpositive_price"
  | "non_finite"
  | "impossible_ohlc"
  | "negative_volume"
  | "suspicious_move";

export interface RejectedBar {
  date: string;
  reason: BarRejection;
}

export interface YahooHistory {
  meta: YahooMeta;
  bars: DailyBar[];
  events: YahooEvent[];
  rejected: RejectedBar[];
  hash: string;
}

export interface HistoryWindow {
  from: string;
  toExclusive: string;
}

export interface HistoryExpectation {
  symbol: string;
  instrumentType: InstrumentType;
  currency?: string;
  exchange?: string;
  today?: string;
}

export interface HistoryOptions extends Omit<HistoryExpectation, "symbol"> {
  bucket?: string;
  signal?: AbortSignal;
}

export class PriceValidationError extends AppError {
  constructor(source: string, message: string, details?: Record<string, unknown>) {
    super(`${source}: ${message}`, "non_retryable", 422, { source, ...details });
  }
}

const SUSPICIOUS_MOVE = 0.4;
const IST_OFFSET_MS = 5.5 * 3600 * 1000;
const DAY_MS = 86_400_000;

interface ChartEvents {
  dividends?: Record<string, { amount?: unknown; date?: unknown }>;
  splits?: Record<string, { numerator?: unknown; denominator?: unknown; date?: unknown }>;
}

interface ChartResponse {
  chart: {
    result: Array<{
      meta: {
        symbol: string;
        currency: string;
        regularMarketPrice: number;
        chartPreviousClose?: number;
        previousClose?: number;
        regularMarketTime: number;
        marketState?: string;
        exchangeName?: string;
        instrumentType?: string;
        exchangeTimezoneName?: string;
        gmtoffset?: number;
        firstTradeDate?: number | null;
      };
      timestamp?: number[];
      events?: ChartEvents;
      indicators: {
        quote: Array<{
          open: (number | null)[];
          high: (number | null)[];
          low: (number | null)[];
          close: (number | null)[];
          volume: (number | null)[];
        }>;
        adjclose?: Array<{ adjclose: (number | null)[] }>;
      };
    }> | null;
    error: { code: string; description: string } | null;
  };
}

export const toYahooSymbol = (nseSymbol: string): string => `${nseSymbol}.NS`;

export class YahooSource {
  constructor(private readonly http: HttpClient) {}

  async chart(
    symbol: string,
    range: YahooRange,
    interval: "1d" | "1wk" = "1d",
  ): Promise<ChartResponse["chart"]["result"]> {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&events=div%2Csplit`;
    const res = await this.http.get(url, { headers: { accept: "application/json" } });
    if (res.status === 404) return null;
    const json = JSON.parse(res.text()) as ChartResponse;
    if (json.chart.error)
      throw new UpstreamError("yahoo", json.chart.error.description, { symbol });
    return json.chart.result;
  }

  async dailyBarsBetween(
    symbol: string,
    window: HistoryWindow,
    opts: HistoryOptions,
  ): Promise<YahooHistory | null> {
    const { bucket, signal, ...expect } = opts;
    const parts: YahooHistory[] = [];
    for (const w of yearWindows(window)) {
      signal?.throwIfAborted();
      const res = await this.http.get(chartUrl(symbol, w), {
        headers: { accept: "application/json" },
        retries: 1,
        ...(bucket ? { bucket } : {}),
        ...(signal ? { signal } : {}),
      });
      const parsed = parseChartHistory(res.status, res.text(), w, { ...expect, symbol });
      if (!parsed) return null;
      parts.push(parsed);
    }
    return mergeHistories(parts);
  }

  async dailyBars(symbol: string, range: YahooRange): Promise<DailyBar[]> {
    const result = (await this.chart(symbol, range))?.[0];
    if (!result?.timestamp) return [];
    const q = result.indicators.quote[0];
    const adj = result.indicators.adjclose?.[0]?.adjclose;
    if (!q) return [];
    return result.timestamp.flatMap((ts, i) => {
      const close = q.close[i];
      if (close == null) return [];
      return [
        {
          date: istDate(ts),
          open: q.open[i] ?? null,
          high: q.high[i] ?? null,
          low: q.low[i] ?? null,
          close,
          adjClose: adj?.[i] ?? null,
          volume: q.volume[i] ?? null,
        },
      ];
    });
  }

  async quote(symbol: string): Promise<Quote | null> {
    const result = (await this.chart(symbol, "5d"))?.[0];
    if (!result) return null;
    const m = result.meta;
    const prev = m.chartPreviousClose ?? m.previousClose ?? null;
    const change = prev == null ? null : m.regularMarketPrice - prev;
    return {
      symbol: m.symbol,
      price: m.regularMarketPrice,
      previousClose: prev,
      change,
      changePct: prev ? ((change as number) / prev) * 100 : null,
      currency: m.currency,
      marketTime: new Date(m.regularMarketTime * 1000),
      marketState: m.marketState ?? null,
    };
  }
}

export function istDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000 + IST_OFFSET_MS).toISOString().slice(0, 10);
}

export function istToday(now = Date.now()): string {
  return new Date(now + IST_OFFSET_MS).toISOString().slice(0, 10);
}

export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

export function addYears(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() + n);
  return d.toISOString().slice(0, 10);
}

function istMidnightUnix(day: string): number {
  return Math.round((Date.parse(`${day}T00:00:00Z`) - IST_OFFSET_MS) / 1000);
}

export function chartUrl(symbol: string, w: HistoryWindow): string {
  const p1 = istMidnightUnix(w.from);
  const p2 = istMidnightUnix(w.toExclusive);
  return `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${p1}&period2=${p2}&interval=1d&events=div%2Csplit&includeAdjustedClose=true`;
}

export function yearWindows(w: HistoryWindow): HistoryWindow[] {
  const out: HistoryWindow[] = [];
  for (let from = w.from; from < w.toExclusive; ) {
    const next = addYears(from, 1);
    const toExclusive = next < w.toExclusive ? next : w.toExclusive;
    out.push({ from, toExclusive });
    from = toExclusive;
  }
  return out;
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function priceTolerance(price: number): number {
  return Math.max(0.05, Math.abs(price) * 1e-4);
}

export function barRejection(bar: DailyBar): BarRejection | null {
  const prices = [bar.open, bar.high, bar.low, bar.close, bar.adjClose].filter(
    (v): v is number => v != null,
  );
  if (
    prices.some((v) => !Number.isFinite(v)) ||
    (bar.volume != null && !Number.isFinite(bar.volume))
  )
    return "non_finite";
  if (prices.some((v) => v <= 0)) return "nonpositive_price";
  if (bar.volume != null && bar.volume < 0) return "negative_volume";
  const { open, high, low, close } = bar;
  if (high != null && low != null) {
    const tol = priceTolerance(high);
    if (high + tol < low) return "impossible_ohlc";
    if (high + tol < Math.max(open ?? close, close)) return "impossible_ohlc";
    if (low - tol > Math.min(open ?? close, close)) return "impossible_ohlc";
  }
  return null;
}

function parseEvents(events: ChartEvents | undefined, currency: string): YahooEvent[] {
  const out: YahooEvent[] = [];
  for (const d of Object.values(events?.dividends ?? {})) {
    if (!finite(d.date) || !finite(d.amount) || d.amount < 0)
      throw new UpstreamError("yahoo", "malformed dividend event");
    const exDate = istDate(d.date);
    out.push({
      type: "dividend",
      exDate,
      eventKey: `dividend:${exDate}`,
      numerator: null,
      denominator: null,
      cashAmount: d.amount,
      currency,
    });
  }
  for (const s of Object.values(events?.splits ?? {})) {
    if (!finite(s.date) || !finite(s.numerator) || !finite(s.denominator))
      throw new UpstreamError("yahoo", "malformed split event");
    if (s.numerator <= 0 || s.denominator <= 0)
      throw new UpstreamError("yahoo", "nonpositive split ratio");
    const exDate = istDate(s.date);
    out.push({
      type: "split",
      exDate,
      eventKey: `split:${exDate}`,
      numerator: s.numerator,
      denominator: s.denominator,
      cashAmount: null,
      currency: null,
    });
  }
  return out.sort((a, b) => a.eventKey.localeCompare(b.eventKey));
}

export function parseChartHistory(
  status: number,
  text: string,
  window: HistoryWindow,
  expect: HistoryExpectation,
): YahooHistory | null {
  let json: ChartResponse;
  try {
    json = JSON.parse(text) as ChartResponse;
  } catch {
    throw new UpstreamError("yahoo", `non-JSON chart response (status ${status})`, {
      symbol: expect.symbol,
    });
  }
  if (!json || typeof json !== "object" || !json.chart)
    throw new UpstreamError("yahoo", "chart response without chart", { symbol: expect.symbol });
  if (json.chart.error) {
    if (status === 404 || json.chart.error.code === "Not Found") return null;
    throw new UpstreamError("yahoo", json.chart.error.description, { symbol: expect.symbol });
  }
  if (status !== 200)
    throw new UpstreamError("yahoo", `status ${status}`, { symbol: expect.symbol });
  const result = json.chart.result?.[0];
  if (!result?.meta)
    throw new UpstreamError("yahoo", "empty chart result", { symbol: expect.symbol });

  const m = result.meta;
  const meta: YahooMeta = {
    symbol: m.symbol,
    currency: m.currency,
    exchange: m.exchangeName ?? "",
    instrumentType: m.instrumentType ?? "",
    timezone: m.exchangeTimezoneName ?? "",
    gmtOffsetSeconds: m.gmtoffset ?? 0,
    firstTradeDate: finite(m.firstTradeDate) ? istDate(m.firstTradeDate) : null,
  };
  const mismatch: string[] = [];
  if (meta.symbol?.toUpperCase() !== expect.symbol.toUpperCase()) mismatch.push("symbol");
  if (meta.currency !== (expect.currency ?? "INR")) mismatch.push("currency");
  if (meta.exchange !== (expect.exchange ?? "NSI")) mismatch.push("exchange");
  if (meta.instrumentType !== expect.instrumentType) mismatch.push("instrumentType");
  if (mismatch.length)
    throw new PriceValidationError("yahoo", `instrument mismatch: ${mismatch.join(",")}`, {
      symbol: expect.symbol,
      meta,
    });

  const ts = result.timestamp ?? [];
  const q = result.indicators?.quote?.[0];
  const adj = result.indicators?.adjclose?.[0]?.adjclose;
  if (ts.length && !q) throw new UpstreamError("yahoo", "timestamps without quotes");
  const columns = q ? [q.open, q.high, q.low, q.close, q.volume] : [];
  if (
    columns.some((c) => !Array.isArray(c) || c.length !== ts.length) ||
    (adj && adj.length !== ts.length)
  )
    throw new UpstreamError("yahoo", "ragged indicator arrays", { symbol: expect.symbol });

  const today = expect.today ?? istToday();
  const events = parseEvents(result.events, meta.currency);
  const splitDates = new Set(events.filter((e) => e.type === "split").map((e) => e.exDate));
  const seen = new Set<string>();
  const bars: DailyBar[] = [];
  const rejected: RejectedBar[] = [];
  let prevClose: number | null = null;
  ts.forEach((t, i) => {
    if (!finite(t)) throw new UpstreamError("yahoo", "non-numeric timestamp");
    const date = istDate(t);
    if (seen.has(date))
      throw new PriceValidationError("yahoo", `duplicate bar ${date}`, { symbol: expect.symbol });
    seen.add(date);
    if (date > today)
      throw new PriceValidationError("yahoo", `future bar ${date}`, { symbol: expect.symbol });
    if (date < window.from || date >= window.toExclusive) return;
    const close = q?.close[i];
    if (close == null) return;
    const bar: DailyBar = {
      date,
      open: q?.open[i] ?? null,
      high: q?.high[i] ?? null,
      low: q?.low[i] ?? null,
      close,
      adjClose: adj?.[i] ?? null,
      volume: q?.volume[i] ?? null,
    };
    const reason = barRejection(bar);
    if (reason) {
      rejected.push({ date, reason });
      return;
    }
    if (
      prevClose !== null &&
      Math.abs(close / prevClose - 1) > SUSPICIOUS_MOVE &&
      !splitDates.has(date)
    ) {
      rejected.push({ date, reason: "suspicious_move" });
      return;
    }
    prevClose = close;
    bars.push(bar);
  });
  const inWindow = events.filter((e) => e.exDate >= window.from && e.exDate < window.toExclusive);
  return {
    meta,
    bars,
    events: inWindow,
    rejected,
    hash: sha256(JSON.stringify({ bars, events: inWindow })),
  };
}

function mergeHistories(parts: YahooHistory[]): YahooHistory | null {
  const first = parts[0];
  if (!first) return null;
  if (parts.length === 1) return first;
  const bars = parts.flatMap((p) => p.bars);
  const events = parts.flatMap((p) => p.events);
  return {
    meta: first.meta,
    bars,
    events,
    rejected: parts.flatMap((p) => p.rejected),
    hash: sha256(parts.map((p) => p.hash).join(":")),
  };
}
