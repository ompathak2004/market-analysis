import { describe, expect, it } from "vitest";
import { targetStats } from "./targets";

describe("targetStats", () => {
  it("averages the two middle targets for an even count", () => {
    expect(targetStats([1500, 1200, 1800, 1400])).toEqual({
      count: 4,
      low: 1200,
      high: 1800,
      mean: 1475,
      median: 1450,
    });
  });

  it("takes the middle target for an odd count and ignores missing or zero targets", () => {
    const s = targetStats([1300, null, 0, 1100, 1700]);
    expect([s.count, s.median]).toEqual([3, 1300]);
  });

  it("returns nulls without targets", () => {
    expect(targetStats([])).toEqual({ count: 0, low: null, high: null, mean: null, median: null });
  });
});
