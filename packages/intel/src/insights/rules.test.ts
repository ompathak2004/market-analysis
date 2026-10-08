import { describe, expect, it } from "vitest";
import { companyFixture } from "./fixtures.js";
import { computeRuleInsights, qualityCriteria, slope } from "./rules.js";

const byId = (inputs = companyFixture()) =>
  new Map(computeRuleInsights(inputs).map((r) => [r.id, r]));

describe("slope", () => {
  it("fits a least-squares slope", () => {
    expect(slope([18, 19, 20, 21])).toBeCloseTo(1);
    expect(slope([5, 5, 5])).toBe(0);
    expect(slope([1])).toBeNull();
  });
});

describe("qualityCriteria", () => {
  it("scores all seven checks when two years are available", () => {
    const [a0, a1] = companyFixture().fundamentals?.annual ?? [];
    expect(a0 && qualityCriteria(a0, a1)).toEqual({ score: 7, of: 7 });
  });

  it("only uses single-year checks without a prior year", () => {
    const [a0] = companyFixture().fundamentals?.annual ?? [];
    expect(a0 && qualityCriteria({ ...a0, cashFromOps: 1_000 }, undefined)).toEqual({
      score: 2,
      of: 3,
    });
  });
});

describe("computeRuleInsights", () => {
  it("emits every applicable rule for a full non-financial company", () => {
    const r = byId();
    expect([...r.keys()].sort()).toEqual(
      [
        "consensus.revision",
        "consensus.skew",
        "consensus.surprise_streak",
        "consensus.upside_to_mean",
        "financials.cagr3y",
        "financials.cash_conversion",
        "financials.growth_vs_sector",
        "financials.leverage",
        "financials.margin_trend",
        "financials.quality_score",
        "industry.margin_vs_sector",
        "price.dist_52w",
        "price.ma_regime",
        "price.rel_nifty",
        "shareholding.dii_qoq",
        "shareholding.fii_qoq",
        "shareholding.pledge",
        "shareholding.promoter_qoq",
        "supply_chain.concentration",
        "supply_chain.distress",
        "supply_chain.momentum",
      ].sort(),
    );
  });

  it("assigns tones from the thresholds", () => {
    const r = byId();
    const tones = Object.fromEntries([...r].map(([id, x]) => [id, x.tone]));
    expect(tones).toMatchObject({
      "price.dist_52w": "negative",
      "price.ma_regime": "positive",
      "price.rel_nifty": "positive",
      "financials.growth_vs_sector": "positive",
      "industry.margin_vs_sector": "positive",
      "financials.cagr3y": "positive",
      "financials.margin_trend": "positive",
      "financials.leverage": "positive",
      "financials.cash_conversion": "positive",
      "financials.quality_score": "positive",
      "shareholding.promoter_qoq": "neutral",
      "shareholding.fii_qoq": "negative",
      "shareholding.dii_qoq": "positive",
      "shareholding.pledge": "positive",
      "consensus.upside_to_mean": "positive",
      "consensus.skew": "positive",
      "consensus.revision": "positive",
      "consensus.surprise_streak": "positive",
      "supply_chain.concentration": "negative",
      "supply_chain.momentum": "negative",
      "supply_chain.distress": "positive",
    });
  });

  it("writes copy with grounded figures", () => {
    const r = byId();
    expect(r.get("price.dist_52w")?.text).toBe(
      "Trading 22.2% below the 52-week high of ₹2,250, 16.7% above the 52-week low of ₹1,500.",
    );
    expect(r.get("financials.growth_vs_sector")?.text).toBe(
      "Revenue grew 14.3% YoY vs the Industrials median of 7.5% (+6.8 pp); PAT 25.0% vs 9.0%.",
    );
    expect(r.get("financials.margin_trend")?.text).toContain("18.0% → 19.0% → 20.0% → 21.0%");
    expect(r.get("consensus.surprise_streak")?.text).toBe(
      "2 consecutive quarterly net profit beats.",
    );
    expect(r.get("shareholding.fii_qoq")?.text).toBe(
      "FII holding fell 1.60 pp to 18.40% in the 2026-06 quarter.",
    );
    expect(r.get("supply_chain.concentration")?.evidence).toEqual(["sig:supply_chain", "rel:1"]);
  });

  it("flags price weakness near the low and a death cross", () => {
    const base = companyFixture();
    const price = base.price ? { ...base.price } : null;
    if (!price) throw new Error("fixture");
    const r = byId(
      companyFixture({
        price: {
          ...price,
          last: 1_520,
          distToHighPct: -14,
          distToLowPct: 1.3,
          cross: { kind: "death", sessionsAgo: 3 },
          relVsNifty3mPct: null,
          relVsNifty1mPct: -4,
        },
      }),
    );
    expect(r.get("price.dist_52w")?.tone).toBe("negative");
    expect(r.get("price.dist_52w")?.text).toContain("Within 1.3% of the 52-week low");
    expect(r.get("price.ma_regime")?.tone).toBe("negative");
    expect(r.get("price.ma_regime")?.text).toContain("death cross formed 3 sessions ago");
    expect(r.get("price.rel_nifty")?.text).toBe(
      "Underperformed the NIFTY 50 over 1 month (-4.0 pp).",
    );
  });

  it("skips margin, leverage and quality rules for financials", () => {
    const base = companyFixture();
    const r = byId(
      companyFixture({ company: { ...base.company, industry: "Private Sector Bank" } }),
    );
    for (const id of [
      "industry.margin_vs_sector",
      "financials.margin_trend",
      "financials.leverage",
      "financials.cash_conversion",
      "financials.quality_score",
    ])
      expect(r.has(id)).toBe(false);
    expect(r.has("financials.growth_vs_sector")).toBe(true);
  });

  it("drops groups whose inputs are missing", () => {
    const r = byId(
      companyFixture({ price: null, consensus: null, shareholding: null, supplyChain: null }),
    );
    expect(
      [...r.keys()].every((id) => id.startsWith("financials.") || id.startsWith("industry.")),
    ).toBe(true);
  });

  it("flags high pledge and stretched leverage", () => {
    const base = companyFixture();
    const sh = base.shareholding;
    const f = base.fundamentals;
    if (!sh || !f) throw new Error("fixture");
    const r = byId(
      companyFixture({
        shareholding: { ...sh, pledgePct: 32.5 },
        fundamentals: { ...f, ratios: { ...f.ratios, debtToEquity: 1.8, interestCover: 2.1 } },
      }),
    );
    expect(r.get("shareholding.pledge")?.text).toBe(
      "High promoter pledge of 32.50% of promoter holding.",
    );
    expect(r.get("financials.leverage")?.tone).toBe("negative");
    expect(r.get("financials.leverage")?.text).toBe(
      "Balance sheet: debt/equity 1.80, interest cover 2.1x.",
    );
  });

  it("passes alt-data reads through and skips coverage signals", () => {
    const evidence = [{ kind: "leg" as const, id: 77, label: "VT-ABC BOM→DEL", at: "2026-10-06" }];
    const window = { from: "2026-10-01", to: "2026-10-07" };
    const r = byId(
      companyFixture({
        travel: [
          {
            kind: "travel_coverage",
            asOf: "2026-10-07",
            value: 2,
            inputs: { read: "2 aircraft tracked.", confidence: 1, evidence: [], window },
          },
          {
            kind: "travel_legs_7d",
            asOf: "2026-10-07",
            value: 4,
            inputs: {
              read: "4 legs in 7 days, 2x the baseline.",
              confidence: 0.6,
              evidence,
              window,
            },
          },
        ],
      }),
    );
    expect(r.has("alt_data.travel_coverage")).toBe(false);
    expect(r.get("alt_data.travel_legs_7d")).toMatchObject({
      group: "alt_data",
      value: 4,
      evidence: ["leg:77"],
    });
  });
});
