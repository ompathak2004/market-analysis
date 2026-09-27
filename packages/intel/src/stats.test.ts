import { describe, expect, it } from "vitest";
import { hhi, ols, zScores } from "./stats.js";

describe("ols", () => {
  it("recovers coefficients of a linear model", () => {
    const X = [
      [1, 2],
      [2, 1],
      [3, 5],
      [4, 3],
      [5, 8],
      [6, 2],
      [7, 7],
    ];
    const y = X.map(([a, b]) => 1 + 2 * (a as number) - 0.5 * (b as number));
    const r = ols(X, y);
    expect(r.coefficients.map((c) => Math.round(c * 1000) / 1000)).toEqual([1, 2, -0.5]);
    expect(r.r2).toBeCloseTo(1);
  });

  it("rejects underdetermined systems", () => {
    expect(() => ols([[1], [2]], [1, 2])).toThrow();
  });
});

describe("zScores", () => {
  it("standardizes and preserves nulls", () => {
    const z = zScores([1, 2, 3, null]);
    expect(z[3]).toBeNull();
    expect(z[1]).toBeCloseTo(0);
  });
});

describe("hhi", () => {
  it("is 1 for a single counterparty", () => {
    expect(hhi([1])).toBe(1);
    expect(hhi([0.5, 0.5])).toBe(0.5);
  });
});
