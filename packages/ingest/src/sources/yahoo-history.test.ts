import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  barRejection,
  chartUrl,
  type DailyBar,
  istDate,
  PriceValidationError,
  parseChartHistory,
  yearWindows,
} from "./yahoo.js";

const fixture = (name: string) =>
  readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8");

const reliance = fixture("yahoo-reliance-2024.json");
const nsei = fixture("yahoo-nsei-2024-10.json");
const window2024 = { from: "2024-08-12", toExclusive: "2024-11-05" };
const equity = { symbol: "RELIANCE.NS", instrumentType: "EQUITY" as const, today: "2026-10-13" };

describe("parseChartHistory", () => {
  it("parses bars, split and dividend events and exchange metadata", () => {
    const h = parseChartHistory(200, reliance, window2024, equity);
    expect(h).not.toBeNull();
    if (!h) return;
    expect(h.meta).toMatchObject({
      symbol: "RELIANCE.NS",
      currency: "INR",
      exchange: "NSI",
      instrumentType: "EQUITY",
      timezone: "Asia/Kolkata",
      gmtOffsetSeconds: 19800,
    });
    expect(h.bars.length).toBe(59);
    expect(h.rejected).toEqual([]);
    expect(h.events).toEqual([
      {
        type: "dividend",
        exDate: "2024-08-19",
        eventKey: "dividend:2024-08-19",
        numerator: null,
        denominator: null,
        cashAmount: 5,
        currency: "INR",
      },
      {
        type: "split",
        exDate: "2024-10-28",
        eventKey: "split:2024-10-28",
        numerator: 2,
        denominator: 1,
        cashAmount: null,
        currency: null,
      },
    ]);
    const dates = h.bars.map((b) => b.date);
    expect(dates).toEqual([...dates].sort());
    expect(new Set(dates).size).toBe(dates.length);
    const pre = h.bars.find((b) => b.date === "2024-10-25");
    expect(pre?.close).toBeLessThan(1500);
    expect(pre?.adjClose).toBeLessThan(pre?.close ?? 0);
  });

  it("drops bars and events outside the exclusive window", () => {
    const h = parseChartHistory(
      200,
      reliance,
      { from: "2024-09-01", toExclusive: "2024-10-28" },
      equity,
    );
    expect(h?.bars.at(-1)?.date).toBe("2024-10-25");
    expect(h?.bars[0]?.date).toBe("2024-09-02");
    expect(h?.events).toEqual([]);
  });

  it("parses an index with INDEX instrument type", () => {
    const h = parseChartHistory(
      200,
      nsei,
      { from: "2024-10-01", toExclusive: "2024-10-15" },
      { symbol: "^NSEI", instrumentType: "INDEX", today: "2026-10-13" },
    );
    expect(h?.meta.instrumentType).toBe("INDEX");
    expect(h?.bars.length).toBe(9);
    expect(h?.events).toEqual([]);
  });

  it("returns null for an unknown symbol", () => {
    expect(
      parseChartHistory(404, fixture("yahoo-not-found.json"), window2024, {
        ...equity,
        symbol: "NOSUCHXYZ.NS",
      }),
    ).toBeNull();
  });

  it("treats a 200 HTML block page as an error, not an empty history", () => {
    expect(() =>
      parseChartHistory(200, fixture("nse-region-block.html.txt"), window2024, equity),
    ).toThrow(/non-JSON/);
  });

  it("rejects the wrong instrument, exchange or currency", () => {
    expect(() =>
      parseChartHistory(200, reliance, window2024, { ...equity, symbol: "TCS.NS" }),
    ).toThrow(PriceValidationError);
    expect(() =>
      parseChartHistory(200, reliance, window2024, { ...equity, instrumentType: "INDEX" }),
    ).toThrow(/instrumentType/);
    expect(() =>
      parseChartHistory(200, reliance, window2024, { ...equity, currency: "USD" }),
    ).toThrow(/currency/);
  });

  it("fails on future and duplicate bars", () => {
    expect(() =>
      parseChartHistory(200, reliance, window2024, { ...equity, today: "2024-09-01" }),
    ).toThrow(/future bar/);
    const json = JSON.parse(reliance);
    const r = json.chart.result[0];
    r.timestamp[1] = r.timestamp[0] + 60;
    expect(() => parseChartHistory(200, JSON.stringify(json), window2024, equity)).toThrow(
      /duplicate bar/,
    );
  });

  it("fails on ragged indicator arrays", () => {
    const json = JSON.parse(reliance);
    json.chart.result[0].indicators.quote[0].close.pop();
    expect(() => parseChartHistory(200, JSON.stringify(json), window2024, equity)).toThrow(
      /ragged/,
    );
  });

  it("quarantines invalid and suspicious bars instead of storing them", () => {
    const json = JSON.parse(reliance);
    const q = json.chart.result[0].indicators.quote[0];
    q.close[3] = -1;
    q.close[10] = q.close[9] * 2;
    q.high[10] = q.close[10];
    const h = parseChartHistory(200, JSON.stringify(json), window2024, equity);
    const ts = json.chart.result[0].timestamp;
    expect(h?.rejected).toEqual([
      { date: istDate(ts[3]), reason: "nonpositive_price" },
      { date: istDate(ts[10]), reason: "suspicious_move" },
    ]);
    expect(h?.bars.length).toBe(57);
  });
});

describe("barRejection", () => {
  const bar = (b: Partial<DailyBar>): DailyBar => ({
    date: "2025-01-02",
    open: 100,
    high: 105,
    low: 95,
    close: 101,
    adjClose: 99,
    volume: 10,
    ...b,
  });

  it("accepts a sane bar and float noise within tick tolerance", () => {
    expect(barRejection(bar({}))).toBeNull();
    expect(barRejection(bar({ high: 100.999999, close: 101 }))).toBeNull();
    expect(barRejection(bar({ volume: null, open: null, high: null, low: null }))).toBeNull();
  });

  it("rejects impossible, nonpositive, negative and non-finite values", () => {
    expect(barRejection(bar({ high: 90 }))).toBe("impossible_ohlc");
    expect(barRejection(bar({ low: 102 }))).toBe("impossible_ohlc");
    expect(barRejection(bar({ close: 0 }))).toBe("nonpositive_price");
    expect(barRejection(bar({ volume: -1 }))).toBe("negative_volume");
    expect(barRejection(bar({ adjClose: Number.NaN }))).toBe("non_finite");
    expect(barRejection(bar({ high: Number.POSITIVE_INFINITY }))).toBe("non_finite");
  });
});

describe("history windows", () => {
  it("splits a range into contiguous exclusive one-year windows", () => {
    expect(yearWindows({ from: "2021-10-13", toExclusive: "2023-12-01" })).toEqual([
      { from: "2021-10-13", toExclusive: "2022-10-13" },
      { from: "2022-10-13", toExclusive: "2023-10-13" },
      { from: "2023-10-13", toExclusive: "2023-12-01" },
    ]);
  });

  it("requests IST-midnight period boundaries with events and adjusted close", () => {
    const url = chartUrl("M&M.NS", { from: "2025-01-01", toExclusive: "2026-01-01" });
    expect(url).toContain("/chart/M%26M.NS?");
    expect(url).toContain(`period1=${Date.UTC(2024, 11, 31, 18, 30) / 1000}`);
    expect(url).toContain(`period2=${Date.UTC(2025, 11, 31, 18, 30) / 1000}`);
    expect(url).toContain("events=div%2Csplit");
    expect(url).toContain("includeAdjustedClose=true");
  });

  it("converts market-open timestamps to the IST trading date", () => {
    expect(istDate(Date.UTC(2024, 9, 28, 3, 45) / 1000)).toBe("2024-10-28");
    expect(istDate(Date.UTC(2024, 9, 27, 18, 30) / 1000)).toBe("2024-10-28");
    expect(istDate(Date.UTC(2024, 9, 27, 18, 29) / 1000)).toBe("2024-10-27");
  });
});
