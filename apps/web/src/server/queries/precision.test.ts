import { describe, expect, it } from "vitest";
import { decodeSampleCursor, PRECISION_GATE, wilsonLowerBound } from "./precision";

describe("wilsonLowerBound", () => {
  it("matches the closed-form 95% Wilson score lower bound", () => {
    expect(wilsonLowerBound(90, 100)).toBeCloseTo(0.8256, 4);
    expect(wilsonLowerBound(95, 100)).toBeCloseTo(0.8882, 4);
    expect(wilsonLowerBound(100, 100)).toBeCloseTo(0.963, 4);
    expect(wilsonLowerBound(1, 1)).toBeCloseTo(0.2065, 4);
  });

  it("needs 96 of 100 confirmations to clear the gate", () => {
    expect(wilsonLowerBound(95, 100)).toBeLessThan(PRECISION_GATE);
    expect(wilsonLowerBound(96, 100)).toBeGreaterThanOrEqual(PRECISION_GATE);
  });

  it("is zero without labels or successes and widens with a larger z", () => {
    expect(wilsonLowerBound(0, 0)).toBe(0);
    expect(wilsonLowerBound(0, 10)).toBe(0);
    expect(wilsonLowerBound(90, 100, 2.576)).toBeLessThan(wilsonLowerBound(90, 100));
  });

  it("rises with sample size at a fixed ratio", () => {
    expect(wilsonLowerBound(450, 500)).toBeGreaterThan(wilsonLowerBound(90, 100));
  });
});

describe("decodeSampleCursor", () => {
  it("accepts positive observation ids only", () => {
    expect(decodeSampleCursor("42")).toBe(42);
    for (const bad of [null, undefined, "", "0", "-1", "01", "4.2", "1e3", "x", "9".repeat(19)])
      expect(decodeSampleCursor(bad)).toBeNull();
  });
});
