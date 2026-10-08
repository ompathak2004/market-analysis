import { describe, expect, it } from "vitest";
import {
  collectInputNumbers,
  dropViolations,
  extractNumbers,
  isGrounded,
  numbersGroundedInInputs,
  sanitizeEvidence,
  splitSentences,
} from "./validate.js";

describe("extractNumbers", () => {
  it("parses Indian-format, percent, rupee and multiple tokens", () => {
    expect(extractNumbers("Target ₹1,675 (19.8% upside) at 22x FY27 EPS of 1,750.")).toEqual([
      1675, 19.8, 22, 1750,
    ]);
    expect(extractNumbers("₹1,23,456.5 crore")).toEqual([123456.5]);
  });

  it("ignores digits glued to letters", () => {
    expect(extractNumbers("Q2FY27 and NIFTY50 and H1")).toEqual([]);
  });
});

describe("isGrounded", () => {
  const pool = collectInputNumbers({
    last: 1750.4,
    upside: 19.83,
    ratio: 0.42,
    text: "PE of 22.1",
  });

  it("matches rounded and tolerance-close values", () => {
    expect(isGrounded(1750, pool)).toBe(true);
    expect(isGrounded(19.8, pool)).toBe(true);
    expect(isGrounded(42, pool)).toBe(true);
    expect(isGrounded(22, pool)).toBe(true);
  });

  it("exempts small integers, years and window lengths", () => {
    for (const n of [3, 12, 2026, 50, 52, 200]) expect(isGrounded(n, [])).toBe(true);
  });

  it("rejects invented figures", () => {
    expect(isGrounded(1675, pool)).toBe(false);
    expect(isGrounded(13, pool)).toBe(false);
    expect(isGrounded(19.2, pool)).toBe(false);
  });
});

describe("splitSentences", () => {
  it("does not split on decimals", () => {
    expect(splitSentences("Margin was 19.8%. Debt fell. ₹1,675 is the target")).toEqual([
      "Margin was 19.8%.",
      "Debt fell.",
      "₹1,675 is the target",
    ]);
  });
});

describe("numbersGroundedInInputs", () => {
  it("reports offending sentences with paths and skips evidence arrays", () => {
    const out = numbersGroundedInInputs(
      {
        thesis: [
          { point: "Revenue grew 14.3% in 2026.", evidence: ["ann:999"] },
          { point: "Fine. Target ₹9,999 implies upside.", evidence: [] },
        ],
      },
      { revenueYoyPct: 14.3 },
    );
    expect(out).toEqual([
      { path: ["thesis", 1, "point"], sentence: "Target ₹9,999 implies upside.", numbers: [9999] },
    ]);
  });
});

describe("sanitizeEvidence", () => {
  it("removes unknown and duplicate ids", () => {
    const { output, removed } = sanitizeEvidence(
      { a: [{ evidence: ["px", "px", "nope"] }], evidence: ["fin"] },
      new Set(["px", "fin"]),
    );
    expect(output).toEqual({ a: [{ evidence: ["px"] }], evidence: ["fin"] });
    expect(removed).toEqual(["nope"]);
  });
});

describe("dropViolations", () => {
  it("drops array items and scrubs sentences elsewhere", () => {
    const value = {
      thesis: [{ point: "a" }, { point: "b 999" }],
      read: "Good. Bad 999. Fine.",
    };
    const { output, dropped } = dropViolations(
      value,
      [
        { path: ["thesis", 1, "point"], sentence: "b 999", numbers: [999] },
        { path: ["read"], sentence: "Bad 999.", numbers: [999] },
      ],
      new Set(["thesis"]),
    );
    expect(output).toEqual({ thesis: [{ point: "a" }], read: "Good. Fine." });
    expect(dropped).toBe(2);
    expect(value.thesis).toHaveLength(2);
  });
});
