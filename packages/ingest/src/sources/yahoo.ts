import { UpstreamError } from "@ma/core";
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
      };
      timestamp?: number[];
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

export const toYahooSymbol = (nseSymbol: string): string => `${nseSymbol.replace(/&/g, "%26")}.NS`;

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

function istDate(unixSeconds: number): string {
  return new Date((unixSeconds + 5.5 * 3600) * 1000).toISOString().slice(0, 10);
}
