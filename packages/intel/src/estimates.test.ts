import { describe, expect, it } from "vitest";
import {
  type AnnualFinancials,
  applyAggregateCaps,
  ESTIMATE_MODEL_VERSION,
  type Estimate,
  type EstimateEdge,
  estimateInputsHash,
  estimateRelationship,
  fiscalYearOf,
} from "./estimates.js";
import { buildPriors, type Prior, type PriorSample, priorKey } from "./priors.js";

const fin = (periodEnd: string, f: Partial<AnnualFinancials>): AnnualFinancials => ({
  periodEnd,
  revenue: null,
  cogs: null,
  purchases: null,
  capex: null,
  sga: null,
  rnd: null,
  ...f,
});

const supplier = [
  fin("2025-03-31", { revenue: 800 }),
  fin("2026-03-31", { revenue: 1000, cogs: 700 }),
];
const customer = [
  fin("2025-03-31", { revenue: 40000, cogs: 30000 }),
  fin("2026-03-31", { revenue: 50000, cogs: 40000, capex: 2000 }),
];

const edge = (e: Partial<EstimateEdge>): EstimateEdge => ({
  id: 1,
  supplierCompanyId: 10,
  customerCompanyId: 20,
  supplierSector: "Auto Components",
  costBucket: "COGS",
  valueBasis: "unknown",
  disclosedPct: null,
  disclosedValue: null,
  fiscalYear: null,
  cueClass: "mention",
  inUniverse: true,
  ...e,
});

const prior = (p: Partial<Prior>): Prior => ({
  supplierSector: "Auto Components",
  costBucket: "COGS",
  cueClass: "all",
  disclosures: 25,
  suppliers: 6,
  shareP25: 8,
  shareP50: 12,
  shareP75: 20,
  ...p,
});

const table = (...ps: Prior[]) =>
  new Map(ps.map((p) => [priorKey(p.supplierSector, p.costBucket, p.cueClass), p]));

const none = new Map<string, Prior>();

describe("estimateRelationship v2", () => {
  it("is model version 2", () => {
    expect(ESTIMATE_MODEL_VERSION).toBe(2);
  });

  it("values a disclosed revenue share against the stated period's revenue", () => {
    const [e] = estimateRelationship(
      edge({ valueBasis: "revenue_share", disclosedPct: 21, fiscalYear: 2025 }),
      supplier,
      customer,
      none,
    );
    expect(e).toMatchObject({
      method: "disclosed",
      valueBasis: "revenue_share",
      valueCr: 168,
      periodStart: "2024-04-01",
      periodEnd: "2025-03-31",
      supplierRevenuePct: 21,
      customerCostPct: 0.56,
    });
  });

  it("keeps the share but gives no value when the stated period has no revenue", () => {
    const [e] = estimateRelationship(
      edge({ valueBasis: "revenue_share", disclosedPct: 21, fiscalYear: 2019 }),
      supplier,
      customer,
      none,
    );
    expect(e).toMatchObject({ method: "disclosed", valueCr: null, supplierRevenuePct: 21 });
    expect(e?.inputs.reason).toBe("no_supplier_revenue_for_period");
  });

  it("derives a value from the customer's own purchase-share disclosure", () => {
    const [e] = estimateRelationship(
      edge({ valueBasis: "purchase_share", disclosedPct: 5, fiscalYear: 2026 }),
      supplier,
      customer,
      none,
    );
    expect(e).toMatchObject({
      method: "derived",
      valueBasis: "purchase_share",
      valueCr: 2000,
      customerCostPct: 5,
      supplierRevenuePct: 200,
    });
  });

  it("uses the bucket's cost base for the customer share", () => {
    const [e] = estimateRelationship(
      edge({
        costBucket: "CAPEX",
        valueBasis: "annual_flow",
        disclosedValue: 500,
        fiscalYear: 2026,
      }),
      supplier,
      customer,
      none,
    );
    expect(e).toMatchObject({ method: "disclosed", valueCr: 500, customerCostPct: 25 });
  });

  it("prefers disclosed numbers over priors", () => {
    const [e] = estimateRelationship(
      edge({ valueBasis: "annual_flow", disclosedValue: 90 }),
      supplier,
      customer,
      table(prior({})),
    );
    expect(e?.method).toBe("disclosed");
    expect(e?.valueCr).toBe(90);
  });

  it("never folds a contract total into the annual flow", () => {
    const rows = estimateRelationship(
      edge({ valueBasis: "contract_total", disclosedValue: 5000, cueClass: "order" }),
      supplier,
      customer,
      table(prior({ cueClass: "order", shareP25: 2, shareP50: 3, shareP75: 5 })),
    );
    expect(rows.map((r) => [r.valueBasis, r.method, r.valueCr])).toEqual([
      ["contract_total", "disclosed", 5000],
      ["annual_flow", "estimated", 30],
    ]);
  });

  it("estimates from the matching cue-class prior with a p25-p75 range", () => {
    const [e] = estimateRelationship(
      edge({ cueClass: "order" }),
      supplier,
      customer,
      table(prior({}), prior({ cueClass: "order", shareP25: 2, shareP50: 3, shareP75: 5 })),
    );
    expect(e).toMatchObject({
      method: "estimated",
      valueCr: 30,
      valueLowCr: 20,
      valueHighCr: 50,
      supplierRevenuePct: 3,
      periodEnd: "2026-03-31",
    });
    expect(e?.inputs.prior).toMatchObject({ cueClass: "order" });
  });

  it("falls back to the sector-bucket prior across cue classes", () => {
    const [e] = estimateRelationship(edge({}), supplier, customer, table(prior({})));
    expect(e?.valueCr).toBe(120);
    expect(e?.inputs.prior).toMatchObject({ cueClass: "all" });
  });

  it("returns no number without a qualifying prior", () => {
    const [e] = estimateRelationship(edge({}), supplier, customer, none);
    expect(e).toMatchObject({ method: "estimated", valueCr: null, valueLowCr: null });
    expect(e?.inputs.reason).toBe("insufficient_prior");
  });

  it("gives statistical estimates only inside the universe", () => {
    const [e] = estimateRelationship(
      edge({ inUniverse: false }),
      supplier,
      customer,
      table(prior({})),
    );
    expect(e?.valueCr).toBeNull();
    expect(e?.inputs.reason).toBe("outside_universe");
  });

  it("treats April to March as one fiscal year", () => {
    expect(fiscalYearOf("2026-03-31")).toBe(2026);
    expect(fiscalYearOf("2025-04-01")).toBe(2026);
  });
});

describe("aggregate caps", () => {
  const est = (e: Partial<Estimate>): Estimate => ({
    relationshipId: 1,
    customerCompanyId: 20,
    costBucket: "COGS",
    method: "estimated",
    valueBasis: "annual_flow",
    periodStart: "2025-04-01",
    periodEnd: "2026-03-31",
    valueCr: 100,
    valueLowCr: 50,
    valueHighCr: 150,
    supplierRevenuePct: 10,
    customerCostPct: 40,
    inputs: {},
    ...e,
  });

  it("scales statistical shares so a customer's suppliers sum to at most 100%", () => {
    const out = applyAggregateCaps([
      est({ relationshipId: 1, method: "disclosed", customerCostPct: 60, valueCr: 600 }),
      est({ relationshipId: 2, customerCostPct: 40, valueCr: 400 }),
      est({ relationshipId: 3, customerCostPct: 40, valueCr: 400 }),
      est({ relationshipId: 4, valueBasis: "contract_total", customerCostPct: 90 }),
    ]);
    expect(out[0]?.customerCostPct).toBe(60);
    expect(out[1]).toMatchObject({ customerCostPct: 20, valueCr: 200, valueLowCr: 25 });
    expect(out[1]?.inputs.aggregateCapScale).toBe(0.5);
    expect(out[3]?.customerCostPct).toBe(90);
    const total = out
      .filter((e) => e.valueBasis !== "contract_total")
      .reduce((s, e) => s + (e.customerCostPct ?? 0), 0);
    expect(total).toBeLessThanOrEqual(100);
  });

  it("leaves groups under the cap untouched", () => {
    const rows = [est({ customerCostPct: 30 }), est({ relationshipId: 2, customerCostPct: 30 })];
    expect(applyAggregateCaps(rows)).toEqual(rows);
  });

  it("hashes the inputs deterministically", () => {
    expect(estimateInputsHash(est({}))).toBe(estimateInputsHash(est({})));
    expect(estimateInputsHash(est({}))).not.toBe(estimateInputsHash(est({ valueCr: 101 })));
  });
});

describe("priors", () => {
  const sample = (supplierId: number, pct: number, cueClasses: string[] = []): PriorSample => ({
    sector: "Auto Components",
    costBucket: "COGS",
    cueClasses,
    supplierId,
    pct,
  });

  it("needs at least 20 disclosures from 5 suppliers", () => {
    const fewSuppliers = Array.from({ length: 30 }, (_, i) => sample(i % 4, 10 + i));
    expect(buildPriors(fewSuppliers)).toEqual([]);
    const fewDisclosures = Array.from({ length: 19 }, (_, i) => sample(i, 10 + i));
    expect(buildPriors(fewDisclosures)).toEqual([]);
  });

  it("builds quartiles per sector, bucket and cue class plus an all-cues prior", () => {
    const samples = Array.from({ length: 21 }, (_, i) => sample(i % 7, i + 10, ["order"]));
    const priors = buildPriors(samples);
    expect(priors.map((p) => p.cueClass)).toEqual(["all", "order"]);
    expect(priors[0]).toMatchObject({
      disclosures: 21,
      suppliers: 7,
      shareP25: 15,
      shareP50: 20,
      shareP75: 25,
    });
  });
});
