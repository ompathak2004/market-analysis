import { describe, expect, it } from "vitest";
import {
  buildPools,
  describeViolations,
  dropViolations,
  extractTokens,
  isAvailabilityStatement,
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
    expect(isGrounded(token("1,750"), pools.global, false)).toBe(true);
    expect(isGrounded(token("42%"), pools.global, false)).toBe(true);
    expect(isGrounded(token("22"), pools.global, false)).toBe(true);
  });

  it("allows 1% tolerance only against cited evidence", () => {
    expect(isGrounded(token("₹2,300"), cited("brk:1"), true)).toBe(true);
    expect(isGrounded(token("₹2,300"), pools.global, false)).toBe(false);
    expect(isGrounded(token("₹2,300"), cited("px"), true)).toBe(false);
  });

  it("preserves sign", () => {
    expect(isGrounded(token("down 4.2%"), pools.global, false)).toBe(true);
    expect(isGrounded(token("-4.2%"), pools.global, false)).toBe(true);
    expect(isGrounded(token("+4.2%"), pools.global, false)).toBe(false);
  });

  it("rejects fabricated figures that used to be exempt", () => {
    for (const s of ["10% growth", "₹200 Cr", "12", "3 brokers", "100%", "50"])
      expect(isGrounded(token(s), pools.global, false)).toBe(false);
  });

  it("does not match a percent against an amount", () => {
    const p = buildPools({ text: "Order worth ₹15 crore" });
    expect(isGrounded(token("15%"), p.global, false)).toBe(false);
    expect(isGrounded(token("₹15 Cr"), p.global, false)).toBe(true);
  });

  it("scopes alt-data signal figures to the evidence they derive from", () => {
    const p = buildPools({
      evidence: [{ id: "px", kind: "source", label: "Daily prices", url: null }],
      travel: [
        {
          kind: "travel_legs_7d",
          value: 6,
          inputs: { read: "6 legs", evidence: [{ kind: "leg", id: 41, label: "BOM-DEL" }] },
        },
      ],
    });
    expect(isGrounded(token("6"), p.byId.get("leg:41") ?? [], true)).toBe(true);
    expect(p.byId.has("px")).toBe(false);
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
      { known, sections: { fin: { revenueYoyPct: 14.3 } } },
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

  it("flags every sentence in a narrative section with no valid citation", () => {
    const out = validateClaims(
      { valuation: { read: "Trades at 25x. Cheap.", evidence: [] } },
      { pe: 25 },
      { known },
    );
    expect(out).toEqual([
      { path: ["valuation", "read"], sentence: "Trades at 25x.", numbers: [25], reason: "uncited" },
      { path: ["valuation", "read"], sentence: "Cheap.", numbers: [], reason: "uncited" },
    ]);
    expect(describeViolations(out)).toContain("cites no valid id");
  });

  it("rejects uncited narrative claims without numbers", () => {
    const out = validateClaims(
      {
        verdict: {
          label: "constructive",
          oneLiner: "The company won a major export contract.",
          evidence: ["brk:404"],
        },
        divergence: { description: "Brokers split on export margins.", bearCase: null },
        headline: "Banks led the market.",
        evidence: [],
      },
      {},
      { known },
    );
    expect(out.map((v) => [v.path, v.reason, v.sentence])).toEqual([
      [["verdict", "oneLiner"], "uncited", "The company won a major export contract."],
      [["divergence", "description"], "uncited", "Brokers split on export margins."],
      [["headline"], "uncited", "Banks led the market."],
    ]);
  });

  it("accepts explicit availability statements without a citation", () => {
    const out = validateClaims(
      {
        valuation: { read: "Valuation read not available.", evidence: [] },
        consensusRead: "No broker coverage available.",
        targetDispersion: { read: "Not enough targets to measure dispersion." },
        travel: { read: "Data unavailable.", evidence: [] },
        notableCalls: ["No broker coverage."],
        revisionMomentum: { direction: "flat", read: "" },
        evidence: [],
      },
      {},
      { known },
    );
    expect(out).toEqual([]);
  });

  it("still requires grounding for figures inside availability statements", () => {
    const out = validateClaims(
      { read: "Data for 25% of customers is not available.", evidence: [] },
      {},
      { known },
    );
    expect(out.map((v) => v.reason)).toEqual(["uncited"]);
  });

  it("rejects a cited figure that exists only in other evidence", () => {
    const inputs = { shareholding: { promoterPct: 25 }, price: { last: 1_750 } };
    const sections = { fin: { revenue: 12_000 }, shp: inputs.shareholding, px: inputs.price };
    const out = validateClaims(
      { thesis: [{ point: "Revenue grew 25%.", evidence: ["fin"] }] },
      inputs,
      { known: new Set(["fin", "shp", "px"]), sections },
    );
    expect(out).toEqual([
      {
        path: ["thesis", 0, "point"],
        sentence: "Revenue grew 25%.",
        numbers: [25],
        reason: "ungrounded",
      },
    ]);
    const shp = validateClaims(
      { thesis: [{ point: "Promoters hold 25%.", evidence: ["shp"] }] },
      inputs,
      { known: new Set(["fin", "shp", "px"]), sections },
    );
    expect(shp).toEqual([]);
  });

  it("uses the global pool only for claims that carry no citation field", () => {
    const inputs = { shareholding: { promoterPct: 25 } };
    expect(validateClaims({ uncertainty: ["Promoters hold 25%."] }, inputs, { known })).toEqual([]);
    expect(
      validateClaims({ read: "Promoters hold 25%.", evidence: ["fin"] }, inputs, { known }),
    ).toHaveLength(1);
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

describe("isAvailabilityStatement", () => {
  it("matches short absence statements", () => {
    for (const s of [
      "No broker coverage available.",
      "Data unavailable.",
      "Valuation read not available.",
      "Supply-chain data is not available for this company.",
      "Not enough targets to measure dispersion.",
      "Insufficient data.",
      "Peer data missing.",
      "No travel data",
    ])
      expect(isAvailabilityStatement(s)).toBe(true);
  });

  it("does not exempt factual claims", () => {
    for (const s of [
      "The company won a major export contract.",
      "No major order was announced.",
      "No notable broker calls.",
      "Revenue grew but margin data is unavailable.",
      "The company won a big export contract and data is unavailable.",
      "Export orders, though data unavailable.",
    ])
      expect(isAvailabilityStatement(s)).toBe(false);
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
