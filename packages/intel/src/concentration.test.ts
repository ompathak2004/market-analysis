import { RELATIONSHIP_EXTRACTOR_VERSION } from "@ma/ingest";
import { describe, expect, it } from "vitest";
import { CONCENTRATION_MODEL_VERSION, customerConcentration } from "./concentration.js";
import { MOMENTUM_MODEL_VERSION, type WeightedLink } from "./momentum.js";
import { RISK_MODEL_VERSION } from "./risk.js";
import { activeSignalVersion } from "./signal-versions.js";

const link = (counterpartyId: number, valueCr: number | null): WeightedLink => ({
  companyId: 1,
  counterpartyId,
  counterpartyName: `C${counterpartyId}`,
  weight: 0.1,
  valueCr,
  method: valueCr === null ? "statistical" : "disclosed",
});

describe("customer concentration v3", () => {
  it("weights only valued customers and counts the rest", () => {
    const c = customerConcentration([link(2, 300), link(3, 100), link(4, null), link(5, 0)]);
    expect(c?.customers.map((x) => [x.id, x.share])).toEqual([
      [2, 0.75],
      [3, 0.25],
    ]);
    expect(c?.hhi).toBeCloseTo(0.625, 10);
    expect(c?.unvalued).toBe(2);
  });

  it("returns null when no customer has a value", () => {
    expect(customerConcentration([link(2, null)])).toBeNull();
    expect(customerConcentration([])).toBeNull();
  });
});

describe("active signal versions", () => {
  it("maps each graph-derived kind to its current model version", () => {
    expect(activeSignalVersion("customer_hhi")).toBe(CONCENTRATION_MODEL_VERSION);
    expect(activeSignalVersion("customer_momentum_3m")).toBe(MOMENTUM_MODEL_VERSION);
    expect(activeSignalVersion("supplier_momentum_1m")).toBe(MOMENTUM_MODEL_VERSION);
    expect(activeSignalVersion("customer_concentration_pct")).toBe(RELATIONSHIP_EXTRACTOR_VERSION);
    expect(activeSignalVersion("distress_score")).toBe(RISK_MODEL_VERSION);
  });

  it("covers every top-N customer kind and ignores unknown kinds", () => {
    expect(activeSignalVersion("top5_customers_pct")).toBe(RELATIONSHIP_EXTRACTOR_VERSION);
    expect(activeSignalVersion("top10_customers_pct")).toBe(RELATIONSHIP_EXTRACTOR_VERSION);
    expect(activeSignalVersion("topx_customers_pct")).toBeNull();
    expect(activeSignalVersion("gst_filing_score")).toBeNull();
  });
});
