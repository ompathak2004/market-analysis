import { describe, expect, it } from "vitest";
import { applyViolations, finalizeBrief, modelView } from "./brief.js";
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
  it("drops offending points, notes the removal and lowers confidence", () => {
    const brief = briefFixture({
      thesis: [
        { point: "One 14.3%.", evidence: [] },
        { point: "Two 20%.", evidence: [] },
        { point: "Three 31%.", evidence: [] },
        { point: "Four 777.", evidence: [] },
      ],
    });
    const out = applyViolations(brief, [
      { path: ["thesis", 3, "point"], sentence: "Four 777.", numbers: [777], reason: "ungrounded" },
    ]);
    expect(out?.thesis).toHaveLength(3);
    expect(out?.verdict.confidence).toBe(0.56);
    expect(out?.uncertainty.at(-1)).toMatch(/^1 statement removed/);
  });

  it("rejects the brief when fewer than three thesis points survive", () => {
    const out = applyViolations(briefFixture(), [
      { path: ["thesis", 0, "point"], sentence: "x", numbers: [1], reason: "ungrounded" },
    ]);
    expect(out).toBeNull();
  });

  it("rejects the brief when no cited risk survives", () => {
    const out = applyViolations(briefFixture(), [
      { path: ["risks", 0], sentence: "", numbers: [], reason: "uncited" },
    ]);
    expect(out).toBeNull();
  });
});

describe("modelView", () => {
  it("removes urls from evidence", () => {
    expect(modelView(companyFixture()).evidence.every((e) => !("url" in e))).toBe(true);
  });
});
