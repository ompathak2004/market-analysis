import { describe, expect, it } from "vitest";
import { DEMO_PORTFOLIOS, type DemoPortfolio } from "./demo.js";
import { replay } from "./ledger.js";
import { drawdown, valueSeries, xirr } from "./metrics.js";

const none = { splits: [], dividends: [] };

const p: DemoPortfolio = {
  id: "t",
  name: "t",
  thesis: "",
  risk: "low",
  benchmark: "NIFTY50",
  basisAsOf: "2026-01-01",
  synthetic: true,
  transactions: [
    { id: "d1", date: "2025-01-01", kind: "deposit", amount: 1_000 },
    { id: "b1", date: "2025-01-01", kind: "buy", symbol: "A", quantity: 10, price: 50 },
    { id: "b2", date: "2025-02-01", kind: "buy", symbol: "A", quantity: 10, price: 50 },
    { id: "s1", date: "2025-03-01", kind: "sell", symbol: "A", quantity: 15, price: 60 },
    { id: "d2", date: "2025-03-01", kind: "deposit", amount: 500 },
  ],
};

describe("portfolio maths", () => {
  it("replays every demo ledger without negative cash or oversold lots", () => {
    for (const d of DEMO_PORTFOLIOS) expect(() => replay(d, "2026-11-12", none)).not.toThrow();
  });

  it("consumes lots first-in first-out and credits dividends held before ex-date", () => {
    const l = replay(p, "2025-04-01", {
      splits: [],
      dividends: [{ symbol: "A", exDate: "2025-03-15", perShare: 2 }],
    });
    expect(l.disposals.map((d) => [d.lotId, d.quantity])).toEqual([
      ["b1", 10],
      ["b2", 5],
    ]);
    expect(l.dividends[0]?.amount).toBe(10);
    expect(l.cash).toBe(1_000 - 1_000 + 900 + 500 + 10);
  });

  it("solves XIRR for a one-year doubling", () => {
    expect(
      xirr([
        { date: "2025-01-01", amount: -100 },
        { date: "2026-01-01", amount: 200 },
      ]),
    ).toBeCloseTo(1, 4);
  });

  it("keeps the time-weighted index flat across a deposit", () => {
    const closes = new Map([
      [
        "A",
        [
          { date: "2025-02-28", close: 60 },
          { date: "2025-03-01", close: 60 },
        ],
      ],
    ]);
    const s = valueSeries(p, none, closes, "2025-03-01");
    expect(s.points.at(-1)?.index).toBeCloseTo(s.points[0]?.index ?? 0, 9);
    expect(
      drawdown([
        { date: "a", index: 100 },
        { date: "b", index: 80 },
        { date: "c", index: 90 },
      ])?.maxDrawdownPct,
    ).toBeCloseTo(-20, 9);
  });
});
