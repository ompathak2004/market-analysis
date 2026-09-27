import { describe, expect, it } from "vitest";
import { estimateRelationship } from "./estimates.js";

const supplier = { periodEnd: "2026-03-31", revenue: 1000, cogs: 700 };
const customer = { periodEnd: "2026-03-31", revenue: 50000, cogs: 40000 };

describe("estimateRelationship", () => {
  it("derives value from disclosed supplier revenue share", () => {
    const e = estimateRelationship(
      {
        disclosedPct: 21,
        disclosedValue: null,
        disclosureKind: "major_customer",
        evidence: "",
        confidence: 0.9,
      },
      supplier,
      customer,
    );
    expect(e.method).toBe("derived");
    expect(e.valueCr).toBe(210);
    expect(e.customerCostPct).toBeCloseTo(0.525, 1);
  });

  it("uses mandated 10% prior for unquantified major customer mentions", () => {
    const e = estimateRelationship(
      {
        disclosedPct: null,
        disclosedValue: null,
        disclosureKind: "major_customer",
        evidence: "our customer",
        confidence: 0.5,
      },
      supplier,
      customer,
    );
    expect(e.method).toBe("estimated");
    expect(e.valueCr).toBe(100);
    expect(e.valueLowCr).toBeLessThan(100);
    expect(e.valueHighCr).toBeGreaterThan(100);
  });

  it("uses largest-customer prior when available", () => {
    const e = estimateRelationship(
      {
        disclosedPct: null,
        disclosedValue: null,
        disclosureKind: "press",
        evidence: "our largest customer Maruti",
        confidence: 0.5,
      },
      supplier,
      customer,
      { largestCustomerPct: 30 },
    );
    expect(e.valueCr).toBe(300);
    expect(e.inputs.priorBasis).toBe("largest_customer_cue");
  });

  it("returns nulls without supplier revenue", () => {
    const e = estimateRelationship(
      {
        disclosedPct: null,
        disclosedValue: null,
        disclosureKind: "press",
        evidence: "",
        confidence: 0.5,
      },
      null,
      customer,
    );
    expect(e.valueCr).toBeNull();
  });
});
