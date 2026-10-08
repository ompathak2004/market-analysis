import { describe, expect, it } from "vitest";
import {
  buildAliasMatcher,
  extractConcentration,
  extractNamedMentions,
  extractTopCustomerShares,
  matchCompanies,
  normalizeCompanyName,
  toCrore,
} from "./relationships.js";

describe("normalizeCompanyName", () => {
  it("strips legal suffixes and punctuation", () => {
    expect(normalizeCompanyName("Maruti Suzuki India Ltd.")).toBe("maruti suzuki india");
    expect(normalizeCompanyName("Tata Motors Limited")).toBe("tata motors");
  });
});

describe("extractConcentration", () => {
  it("parses Ind AS 108 major customer disclosure", () => {
    const text = `Customers exceeding 10% of total revenue
No of customers exceeding 10% of total revenue 1 2
Total revenue of such customers (INR million) 7,894 10,155.96
The Group's non-current assets`;
    expect(extractConcentration(text)).toEqual({
      customersOver10Pct: 1,
      revenueFromThem: 7894,
      unit: "million",
    });
    expect(toCrore(7894, "million")).toBeCloseTo(789.4);
  });

  it("returns null without disclosure", () => {
    expect(extractConcentration("nothing here")).toBeNull();
  });
});

describe("extractNamedMentions", () => {
  const matcher = buildAliasMatcher([
    { companyId: 1, name: "Maruti Suzuki India Ltd", aliases: ["Maruti Suzuki", "Maruti"] },
    { companyId: 2, name: "Tata Motors Ltd", aliases: [] },
  ]);

  it("finds customer with percentage", () => {
    const text =
      "Our largest customer, Maruti Suzuki, accounted for approximately 32% of our consolidated revenue in FY25. We also expanded capacity.";
    const [m] = extractNamedMentions(text, matcher, 99);
    expect(m).toMatchObject({ companyId: 1, role: "customer", pct: 32 });
  });

  it("ignores self and sentences without cues", () => {
    expect(extractNamedMentions("Tata Motors launched a new SUV.", matcher, 99)).toHaveLength(0);
    expect(
      extractNamedMentions("Sales to Tata Motors were 12% of revenue.", matcher, 2),
    ).toHaveLength(0);
  });
});

describe("extractTopCustomerShares", () => {
  it("parses top-N customer share sentences", () => {
    const text =
      "In Q2, the top 5 customers contribute 51% of total revenue. Contribution from our top 10 customers has been reduced to 72% from 80%.";
    expect(extractTopCustomerShares(text).map((s) => [s.topN, s.pct])).toEqual([
      [5, 51],
      [10, 72],
    ]);
  });
});

describe("buildAliasMatcher symbol handling", () => {
  it("does not match a symbol-derived alias case-insensitively", () => {
    const m = buildAliasMatcher([
      {
        companyId: 1,
        name: "Fertilisers and Chemicals Travancore Ltd.",
        aliases: ["fact"],
        symbol: "FACT",
      },
      {
        companyId: 2,
        name: "Reliance Industries Ltd.",
        aliases: ["reliance jio"],
        symbol: "RELIANCE",
      },
    ]);
    const text =
      "In fact, revenue from Reliance Jio contributed 30% of sales; FACT remains a customer too.";
    const ids = [...matchCompanies(text, m)].map((x) => x.companyId);
    expect(ids).toEqual([2]);
  });
});
