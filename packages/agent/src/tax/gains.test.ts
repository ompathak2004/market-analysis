import { describe, expect, it } from "vitest";
import { estimateGains, type TaxLotInput } from "./gains.js";
import { longTermFrom, yearOf } from "./rules.js";

const lot = (over: Partial<TaxLotInput>): TaxLotInput => ({
  symbol: "X",
  assetClass: "listed_equity",
  acquired: "2025-01-10",
  disposed: "2026-01-10",
  quantity: 100,
  costPerShare: 100,
  salePerShare: 200,
  fmv2018PerShare: null,
  ...over,
});

describe("capital gains rules", () => {
  it("treats the 12-month anniversary as short-term and the next day as long-term", () => {
    expect(longTermFrom("2025-01-10")).toBe("2026-01-11");
    expect(longTermFrom("2024-02-29")).toBe("2025-03-01");
    const [st] = estimateGains([lot({})]).lots;
    const [lt] = estimateGains([lot({ disposed: "2026-01-11" })]).lots;
    expect(st?.term).toBe("short");
    expect(lt?.term).toBe("long");
  });

  it("switches rates on 23 July 2024 and sections on 1 April 2026", () => {
    const r = (disposed: string) =>
      estimateGains([lot({ acquired: "2023-01-02", disposed })]).lots[0];
    expect(r("2024-07-22")?.rate).toBe(0.1);
    expect(r("2024-07-23")?.rate).toBe(0.125);
    expect(r("2026-03-31")?.section).toContain("s.112A");
    expect(r("2026-04-01")?.section).toContain("s.198");
    expect(yearOf("2026-04-01").label).toBe("Tax year 2026-27");
    expect(yearOf("2026-03-31").label).toBe("FY 2025-26");
  });

  it("sets off losses before one aggregate exemption per year", () => {
    const e = estimateGains([
      lot({ symbol: "A", acquired: "2024-01-01", disposed: "2026-05-01", salePerShare: 2_100 }),
      lot({ symbol: "B", acquired: "2026-01-01", disposed: "2026-05-01", salePerShare: 50 }),
    ]);
    const y = e.years[0];
    expect(y?.ltcg).toBe(200_000);
    expect(y?.stcl).toBe(5_000);
    expect(y?.exemptionUsed).toBe(125_000);
    expect(y?.taxableLongTerm).toBe(70_000);
    expect(y?.total).toBeCloseTo(70_000 * 0.125 * 1.04, 6);
  });

  it("grandfathers pre-2018 lots only when the 31 Jan 2018 value is known", () => {
    const missing = estimateGains([lot({ acquired: "2017-06-01", disposed: "2026-06-01" })]);
    expect(missing.exact).toBe(false);
    expect(missing.missing).toHaveLength(1);
    const known = estimateGains([
      lot({ acquired: "2017-06-01", disposed: "2026-06-01", fmv2018PerShare: 150 }),
    ]);
    expect(known.lots[0]?.gain).toBe(5_000);
  });
});
