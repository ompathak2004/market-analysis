import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  isNseBlocked,
  NSE_HISTORY_SOURCES,
  nseDay,
  parseEquityHistory,
  parseEquityList,
  parseIndexHistory,
  windowChunks,
} from "./nse.js";
import { PriceValidationError } from "./yahoo.js";

const fixture = (name: string) =>
  readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8");

const response = (status: number, body: string, type: string) => ({
  status,
  text: () => body,
  headers: new Headers({ "content-type": type }),
});

describe("NSE index history", () => {
  it("parses a captured indicesHistory response oldest first", () => {
    const bars = parseIndexHistory(fixture("nse-indices-history-nifty50.json"), "NIFTY 50");
    expect(bars.length).toBe(4);
    expect(bars.at(-1)).toEqual({
      date: "2026-09-30",
      open: 22665,
      high: 22809.35,
      low: 22595.2,
      close: 22620.45,
      adjClose: null,
      volume: 369406892,
    });
    expect(bars.map((b) => b.date)).toEqual([...bars.map((b) => b.date)].sort());
  });

  it("rejects a response for a different index", () => {
    expect(() =>
      parseIndexHistory(fixture("nse-indices-history-nifty50.json"), "NIFTY BANK"),
    ).toThrow(PriceValidationError);
  });

  it("detects the region block page served with status 200", () => {
    const html = fixture("nse-region-block.html.txt");
    expect(isNseBlocked(response(200, html, "text/html"))).toBe(true);
    expect(isNseBlocked(response(403, "", "text/plain"))).toBe(true);
    expect(isNseBlocked(response(200, '{"data":[]}', "application/json"))).toBe(false);
    expect(() => parseIndexHistory(html, "NIFTY 50")).toThrow(/non-JSON/);
  });
});

describe("NSE equity history (unverified endpoint)", () => {
  it("is not enabled as a production fallback", () => {
    expect(NSE_HISTORY_SOURCES.equity.verified).toBe(false);
    expect(NSE_HISTORY_SOURCES.index.verified).toBe(true);
  });

  it("parses documented CH_* rows and ignores non-EQ series", () => {
    const body = JSON.stringify({
      data: [
        {
          CH_SYMBOL: "TCS",
          CH_SERIES: "EQ",
          CH_TIMESTAMP: "2026-09-01",
          CH_OPENING_PRICE: 3100,
          CH_TRADE_HIGH_PRICE: 3150.5,
          CH_TRADE_LOW_PRICE: 3090,
          CH_CLOSING_PRICE: 3120.4,
          CH_TOT_TRADED_QTY: 1200345,
        },
        { CH_SYMBOL: "TCS", CH_SERIES: "BL", CH_TIMESTAMP: "2026-09-01", CH_CLOSING_PRICE: 1 },
      ],
    });
    expect(parseEquityHistory(body, "TCS")).toEqual([
      {
        date: "2026-09-01",
        open: 3100,
        high: 3150.5,
        low: 3090,
        close: 3120.4,
        adjClose: null,
        volume: 1200345,
      },
    ]);
    expect(() => parseEquityHistory(body, "INFY")).toThrow(/symbol mismatch/);
  });
});

describe("NSE listings and ranges", () => {
  it("parses EQUITY_L listing dates and ISINs", () => {
    const rows = parseEquityList(fixture("nse-equity-list.csv.txt"));
    expect(rows.find((r) => r.symbol === "TCS")).toEqual({
      symbol: "TCS",
      name: "Tata Consultancy Services Limited",
      series: "EQ",
      listedOn: "2004-08-25",
      isin: "INE467B01029",
    });
    expect(rows.length).toBe(5);
  });

  it("parses NSE day strings", () => {
    expect(nseDay("30-SEP-2026")).toBe("2026-09-30");
    expect(nseDay("06-Oct-2008")).toBe("2008-10-06");
    expect(nseDay("2026-09-30")).toBeNull();
  });

  it("splits fallback ranges into bounded chunks", () => {
    expect(windowChunks({ from: "2026-01-01", toExclusive: "2026-04-15" }, 31)).toEqual([
      { from: "2026-01-01", toExclusive: "2026-02-01" },
      { from: "2026-02-01", toExclusive: "2026-03-04" },
      { from: "2026-03-04", toExclusive: "2026-04-04" },
      { from: "2026-04-04", toExclusive: "2026-04-15" },
    ]);
  });
});
