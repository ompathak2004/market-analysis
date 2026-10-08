import { describe, expect, it } from "vitest";
import {
  buildPools,
  describeViolations,
  dropViolations,
  extractTokens,
  isGrounded,
  type NumberToken,
  sanitizeEvidence,
  splitSentences,
  validateClaims,
} from "./validate.js";

const values = (text: string) => extractTokens(text).map((t) => t.value);
const token = (text: string) => extractTokens(text)[0] as NumberToken;

describe("extractTokens", () => {
  it("parses Indian-format, percent, rupee and multiple tokens", () => {
    expect(values("Target ₹1,675 (19.8% upside) at 22x EPS of 1,750.")).toEqual([
      1675, 19.8, 22, 1750,
    ]);
    expect(values("₹1,23,456.5 crore")).toEqual([123456.5]);
    expect(values("Rs1,200 crore order")).toEqual([1200]);
  });

  it("ignores digits glued to letters", () => {
    expect(values("Q2FY27 and NIFTY50 and H1")).toEqual([]);
  });

  it("exempts only dates, fiscal periods and windows", () => {
    expect(
      values(
        "On 2026-10-05, 5 Oct and Oct 5, 2026, in FY 27, Q1 FY27, over 3 years, 7 d, the 52-week high, 200 DMA, 3-5 years and 09:30.",
      ),
    ).toEqual([]);
    expect(values("Revenue grew 10% and capex was ₹200 Cr in 2026.")).toEqual([10, 200]);
  });

  it("keeps explicit signs and tags units", () => {
    expect(extractTokens("fell -5.2% to ₹200 Cr, +3 pp, FY26-27")).toEqual([
      { value: -5.2, signed: true, decimals: 1, unit: "pct" },
      { value: 200, signed: false, decimals: 0, unit: "amount" },
      { value: 3, signed: true, decimals: 0, unit: "pct" },
    ]);
    expect(values("range 1,600 - 2,600")).toEqual([1600, 2600]);
  });
});

describe("isGrounded", () => {
  const pools = buildPools(
    {
      price: { last: 1750.4, chg1mPct: -4.2 },
      brokers: [{ evidenceId: "brk:1", target: 2_310 }],
      ratio: 0.42,
      text: "PE of 22.1",
    },
    { px: { last: 1750.4 } },
  );
  const cited = (id: string) => pools.byId.get(id) ?? [];

  it("matches values after rounding in the global pool", () => {
    expect(isGrounded(token("1,750"), [], pools.global)).toBe(true);
    expect(isGrounded(token("42%"), [], pools.global)).toBe(true);
    expect(isGrounded(token("22"), [], pools.global)).toBe(true);
  });

  it("allows 1% tolerance only against cited evidence", () => {
    expect(isGrounded(token("₹2,300"), cited("brk:1"), pools.global)).toBe(true);
    expect(isGrounded(token("₹2,300"), [], pools.global)).toBe(false);
    expect(isGrounded(token("₹2,300"), cited("px"), pools.global)).toBe(false);
  });

  it("preserves sign", () => {
    expect(isGrounded(token("down 4.2%"), [], pools.global)).toBe(true);
    expect(isGrounded(token("-4.2%"), [], pools.global)).toBe(true);
    expect(isGrounded(token("+4.2%"), [], pools.global)).toBe(false);
  });

  it("rejects fabricated figures that used to be exempt", () => {
    for (const s of ["10% growth", "₹200 Cr", "12", "3 brokers", "100%", "50"])
      expect(isGrounded(token(s), [], pools.global)).toBe(false);
  });

  it("does not match a percent against an amount", () => {
    const p = buildPools({ text: "Order worth ₹15 crore" });
    expect(isGrounded(token("15%"), [], p.global)).toBe(false);
    expect(isGrounded(token("₹15 Cr"), [], p.global)).toBe(true);
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

describe("validateClaims", () => {
  const known = new Set(["fin", "brk:7"]);

  it("reports offending sentences with paths and skips evidence arrays", () => {
    const out = validateClaims(
      {
        thesis: [
          { point: "Revenue grew 14.3% in 2026.", evidence: ["fin"] },
          { point: "Fine. Target ₹9,999 implies upside.", evidence: ["fin"] },
        ],
      },
      { revenueYoyPct: 14.3 },
      { known },
    );
    expect(out).toEqual([
      {
        path: ["thesis", 1, "point"],
        sentence: "Target ₹9,999 implies upside.",
        numbers: [9999],
        reason: "ungrounded",
      },
    ]);
  });

  it("rejects claims whose evidence does not resolve", () => {
    const out = validateClaims(
      {
        thesis: [
          { point: "Cited.", evidence: ["fin"] },
          { point: "Invented source.", evidence: ["brk:404"] },
          { point: "No source.", evidence: [] },
        ],
      },
      {},
      { known },
    );
    expect(out.map((v) => [v.path, v.reason, v.sentence])).toEqual([
      [["thesis", 1], "uncited", "Invented source."],
      [["thesis", 2], "uncited", "No source."],
    ]);
  });

  it("flags figures in a narrative section with no valid citation", () => {
    const out = validateClaims(
      { valuation: { read: "Trades at 25x. Cheap.", evidence: [] } },
      { pe: 25 },
      { known },
    );
    expect(out).toEqual([
      { path: ["valuation", "read"], sentence: "Trades at 25x.", numbers: [25], reason: "uncited" },
    ]);
    expect(describeViolations(out)).toContain("cites no valid id");
  });

  it("rejects fabricated growth and amounts", () => {
    const out = validateClaims(
      {
        read: "Revenue shows 10% growth. Capex of ₹200 Cr is planned.",
        evidence: ["fin"],
      },
      { fundamentals: { revenue: 12_000, capex: 180 }, chg1dPct: 0.4 },
      { known, sections: { fin: { revenue: 12_000 } } },
    );
    expect(out.map((v) => v.numbers)).toEqual([[10], [200]]);
  });

  it("checks figures against the cited source first", () => {
    const inputs = { brokers: [{ evidenceId: "brk:7", target: 2_310 }] };
    const ok = validateClaims({ says: "Target ₹2,300.", evidence: ["brk:7"] }, inputs, { known });
    const wrong = validateClaims({ says: "Target ₹2,300.", evidence: ["fin"] }, inputs, {
      known,
    });
    expect(ok).toEqual([]);
    expect(wrong).toHaveLength(1);
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
        { path: ["thesis", 1, "point"], sentence: "b 999", numbers: [999], reason: "ungrounded" },
        { path: ["read"], sentence: "Bad 999.", numbers: [999], reason: "ungrounded" },
      ],
      new Set(["thesis"]),
    );
    expect(output).toEqual({ thesis: [{ point: "a" }], read: "Good. Fine." });
    expect(dropped).toBe(2);
    expect(value.thesis).toHaveLength(2);
  });
});
