import { describe, expect, it } from "vitest";
import { applyViolations, briefViolations, finalizeBrief, modelView } from "./brief.js";
import { briefFixture, companyFixture } from "./fixtures.js";
import { VERDICT_BANDS, verdictLabelFor } from "./schemas.js";

describe("verdict bands", () => {
  it("maps scores to labels at band edges", () => {
    expect([0, 19, 20, 39, 40, 59, 60, 79, 80, 100].map(verdictLabelFor)).toEqual([
      "bearish",
      "bearish",
      "cautious",
      "cautious",
      "neutral",
      "neutral",
      "constructive",
      "constructive",
      "bullish",
      "bullish",
    ]);
    expect(VERDICT_BANDS.at(-1)?.max).toBe(100);
  });
});

describe("finalizeBrief", () => {
  const inputs = companyFixture();

  it("forces the label to match the score band and clamps values", () => {
    const { brief } = finalizeBrief(
      briefFixture({
        verdict: { score: 83.6, label: "neutral", confidence: 1.4, oneLiner: "x", evidence: [] },
      }),
      inputs,
    );
    expect(brief.verdict).toMatchObject({ score: 84, label: "bullish", confidence: 1 });
    const low = finalizeBrief(
      briefFixture({
        verdict: { score: -5, label: "bullish", confidence: 0.333, oneLiner: "x", evidence: [] },
      }),
      inputs,
    ).brief.verdict;
    expect(low).toMatchObject({ score: 0, label: "bearish", confidence: 0.33 });
  });

  it("strips unknown evidence and absent alt-data reads", () => {
    const { brief, removedEvidence, violations } = finalizeBrief(
      briefFixture({
        thesis: [
          { point: "Revenue grew 14.3% YoY.", evidence: ["fin", "brk:404"] },
          { point: "Mean target ₹2,100.", evidence: ["cns"] },
          { point: "Margin 20%.", evidence: ["fin"] },
        ],
        whatChanged: [{ point: "Score rose.", evidence: ["px"] }],
        managementTravel: { read: "Executives flew to Mumbai.", evidence: [] },
        logistics: { read: "  ", evidence: [] },
      }),
      inputs,
    );
    expect(removedEvidence).toEqual(["brk:404"]);
    expect(brief.thesis[0]?.evidence).toEqual(["fin"]);
    expect(brief.whatChanged).toEqual([]);
    expect(brief.managementTravel.read).toBeNull();
    expect(brief.logistics.read).toBeNull();
    expect(violations).toEqual([]);
  });

  it("reports ungrounded numbers", () => {
    const { violations } = finalizeBrief(
      briefFixture({
        risks: [{ point: "Debt could rise to ₹4,321 crore.", severity: "high", evidence: ["fin"] }],
      }),
      inputs,
    );
    expect(violations).toEqual([
      {
        path: ["risks", 0, "point"],
        sentence: "Debt could rise to ₹4,321 crore.",
        numbers: [4321],
        reason: "ungrounded",
      },
    ]);
  });

  it("reports claims that cite only invented ids", () => {
    const { violations, removedEvidence } = finalizeBrief(
      briefFixture({
        risks: [{ point: "Execution risk.", severity: "high", evidence: ["brk:404"] }],
      }),
      inputs,
    );
    expect(removedEvidence).toEqual(["brk:404"]);
    expect(violations).toEqual([
      { path: ["risks", 0], sentence: "Execution risk.", numbers: [], reason: "uncited" },
    ]);
  });
});

describe("applyViolations", () => {
  const inputs = companyFixture();

  it("drops offending points, notes the removal and lowers confidence", () => {
    const brief = briefFixture({
      thesis: [
        { point: "One 14.3%.", evidence: ["fin"] },
        { point: "Two 20%.", evidence: ["fin"] },
        { point: "Three 31%.", evidence: ["sig:supply_chain"] },
        { point: "Four 777.", evidence: ["fin"] },
      ],
    });
    const out = applyViolations(
      brief,
      [
        {
          path: ["thesis", 3, "point"],
          sentence: "Four 777.",
          numbers: [777],
          reason: "ungrounded",
        },
      ],
      inputs,
    );
    expect(out?.thesis).toHaveLength(3);
    expect(out?.verdict.confidence).toBe(0.56);
    expect(out?.uncertainty.at(-1)).toMatch(/^1 statement removed/);
  });

  it("rejects the brief when fewer than three thesis points survive", () => {
    const out = applyViolations(
      briefFixture(),
      [{ path: ["thesis", 0, "point"], sentence: "x", numbers: [1], reason: "ungrounded" }],
      inputs,
    );
    expect(out).toBeNull();
  });

  it("rejects the brief when no cited risk survives", () => {
    const out = applyViolations(
      briefFixture(),
      [{ path: ["risks", 0], sentence: "", numbers: [], reason: "uncited" }],
      inputs,
    );
    expect(out).toBeNull();
  });

  it("falls back to the first surviving thesis point, not the removed one", () => {
    const brief = briefFixture({
      verdict: {
        score: 71,
        label: "constructive",
        confidence: 0.66,
        oneLiner: "Earnings will double to ₹4,321 crore.",
        evidence: [],
      },
      thesis: [
        { point: "Revenue will hit ₹4,321 crore.", evidence: ["fin"] },
        ...briefFixture().thesis,
      ],
    });
    const { violations } = finalizeBrief(brief, inputs);
    const out = applyViolations(brief, violations, inputs);
    expect(out?.verdict.oneLiner).toBe(briefFixture().thesis[0]?.point);
    expect(out?.verdict.evidence).toEqual(["fin"]);
    expect(out && briefViolations(out, inputs)).toEqual([]);
  });

  it("drops uncited narrative without numbers and lowers confidence", () => {
    const brief = briefFixture({
      verdict: {
        score: 71,
        label: "constructive",
        confidence: 0.66,
        oneLiner: "The company won a major export contract.",
        evidence: [],
      },
      valuation: {
        read: "Re-rating looks likely.",
        vsPeers: "Cheaper than peers.",
        vsConsensus: null,
        evidence: [],
      },
    });
    const { violations } = finalizeBrief(brief, inputs);
    expect(violations.map((v) => [v.path, v.reason])).toEqual([
      [["verdict", "oneLiner"], "uncited"],
      [["valuation", "read"], "uncited"],
      [["valuation", "vsPeers"], "uncited"],
    ]);
    const out = applyViolations(brief, violations, inputs);
    expect(out?.verdict.oneLiner).toBe(briefFixture().thesis[0]?.point);
    expect(out?.verdict.confidence).toBe(0.56);
    expect(out?.valuation).toMatchObject({ read: "Valuation read not available.", vsPeers: null });
    expect(out && briefViolations(out, inputs)).toEqual([]);
  });

  it("re-checks the cleaned brief and rejects anything still ungrounded", () => {
    const brief = briefFixture({
      thesis: [...briefFixture().thesis, { point: "Margin hits 41%.", evidence: ["fin"] }],
      valuation: { read: "Trades at 99x.", vsPeers: null, vsConsensus: null, evidence: ["px"] },
    });
    const out = applyViolations(
      brief,
      [
        {
          path: ["thesis", 3, "point"],
          sentence: "Margin hits 41%.",
          numbers: [41],
          reason: "ungrounded",
        },
      ],
      inputs,
    );
    expect(out).toBeNull();
  });
});

describe("modelView", () => {
  it("removes urls from evidence", () => {
    expect(modelView(companyFixture()).evidence.every((e) => !("url" in e))).toBe(true);
  });
});
