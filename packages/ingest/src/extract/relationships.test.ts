import { describe, expect, it } from "vitest";
import {
  type AliasEntry,
  buildAliasMatcher,
  type CounterpartyKind,
  extractConcentration,
  extractObservations,
  extractTopCustomerShares,
  findMentions,
  matchCompanies,
  normalizeCompanyName,
  type Period,
  toCrore,
} from "./relationships.js";
import { findMoney, splitClauses } from "./text.js";

function entry(
  counterpartyId: number,
  name: string,
  opts: {
    companyId?: number | null;
    kind?: CounterpartyKind;
    phrases?: string[];
    symbols?: string[];
    groupKeys?: string[];
  } = {},
): AliasEntry {
  return {
    counterpartyId,
    companyId: opts.companyId ?? null,
    name,
    kind: opts.kind ?? "listed",
    phrases: opts.phrases ?? [],
    symbols: opts.symbols ?? [],
    groupKeys: opts.groupKeys ?? [],
  };
}

const focal = entry(1, "Acme Telecom Infra Limited", { companyId: 101, phrases: ["Acme Telecom"] });
const airtel = entry(2, "Bharti Airtel Limited", {
  companyId: 102,
  phrases: ["Bharti Airtel", "Airtel"],
  symbols: ["BHARTIARTL"],
  groupKeys: ["bharti"],
});
const fact = entry(3, "Fertilisers and Chemicals Travancore Limited", {
  companyId: 103,
  symbols: ["FACT"],
});
const itc = entry(4, "ITC Limited", { companyId: 104, symbols: ["ITC"] });
const acc = entry(5, "ACC Limited", { companyId: 105, symbols: ["ACC"] });
const tataMotors = entry(6, "Tata Motors Limited", {
  companyId: 106,
  phrases: ["Tata Motors"],
  groupKeys: ["tata"],
});
const tataSteel = entry(7, "Tata Steel Limited", {
  companyId: 107,
  phrases: ["Tata Steel"],
  groupKeys: ["tata"],
});
const maruti = entry(8, "Maruti Suzuki India Limited", {
  companyId: 108,
  phrases: ["Maruti Suzuki", "Maruti"],
});
const matcher = buildAliasMatcher([focal, airtel, fact, itc, acc, tataMotors, tataSteel, maruti]);
const period: Period = { start: "2023-04-01", end: "2024-03-31", fiscalYear: 2024 };

function observe(text: string, from: AliasEntry = focal) {
  return extractObservations(text, matcher, { focal: from, family: "annual_report", period });
}

describe("normalizeCompanyName", () => {
  it("strips legal suffixes but keeps distinctive words", () => {
    expect(normalizeCompanyName("Maruti Suzuki India Ltd.")).toBe("maruti suzuki india");
    expect(normalizeCompanyName("Tata Steel Limited")).toBe("tata steel");
    expect(normalizeCompanyName("Urban Company")).toBe("urban company");
    expect(normalizeCompanyName("The Indian Hotels Company Limited")).toBe("indian hotels");
  });
});

describe("splitClauses", () => {
  it("does not split decimals or abbreviations", () => {
    const text =
      "Revenue grew 12.5% in FY24. Sales to Shree Ram Pvt. Ltd. and Delta Co. rose; plant No. 3 was commissioned.";
    expect(splitClauses(text).map((c) => c.text)).toEqual([
      "Revenue grew 12.5% in FY24.",
      "Sales to Shree Ram Pvt. Ltd. and Delta Co. rose;",
      "plant No. 3 was commissioned.",
    ]);
  });

  it("keeps clause offsets aligned with the source text", () => {
    const text = "First clause here.  Second clause, Inc. included.";
    for (const c of splitClauses(text)) expect(text.slice(c.start, c.end)).toBe(c.text);
  });
});

describe("findMentions", () => {
  it("matches short symbols only as exact uppercase tokens", () => {
    const text = "In fact, the itc on inputs and the acc balance were reconciled.";
    expect(findMentions(text, matcher)).toEqual([]);
  });

  it("ignores symbols inside shouting runs", () => {
    expect(findMentions("GST ITC CLAIMS WERE FILED", matcher)).toEqual([]);
    expect(
      findMentions("We supply packaging to ITC and ACC.", matcher).map((m) => m.entry.name),
    ).toEqual(["ITC Limited", "ACC Limited"]);
  });

  it("matches phrase aliases as whole phrases", () => {
    const mentions = findMentions("Our client Maruti Suzuki India Ltd placed orders.", matcher);
    expect(mentions.map((m) => [m.entry.counterpartyId, m.matched])).toEqual([
      [8, "Maruti Suzuki India"],
    ]);
  });

  it("keeps matchCompanies for callers that only need company ids", () => {
    expect([...matchCompanies("Leased to Bharti Airtel and FACT.", matcher)]).toEqual([
      { companyId: 102, matched: "Bharti Airtel" },
      { companyId: 103, matched: "FACT" },
    ]);
  });
});

describe("extractObservations", () => {
  it("attaches a revenue share to a customer with an explicit denominator", () => {
    const { observations } = observe("Bharti Airtel accounted for 69% of our revenue in FY24.");
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      supplier: { counterpartyId: 1 },
      customer: { counterpartyId: 2 },
      pct: 69,
      valueBasis: "revenue_share",
      cueClass: "revenue_share",
      disclosureKind: "major_customer",
      period: { fiscalYear: 2024, end: "2024-03-31" },
    });
  });

  it("does not attach customer-count growth as a revenue share", () => {
    const { observations } = observe("Our customer count grew 69% with Airtel during the year.");
    for (const o of observations) {
      expect(o.pct).toBeNull();
      expect(o.valueBasis).not.toBe("revenue_share");
      expect(o.cueClass).toBe("customer_count");
    }
  });

  it("does not read common words as short-symbol companies", () => {
    const { observations } = observe(
      "In fact, we supply towers to many operators and the itc on capital goods was claimed.",
    );
    expect(observations).toEqual([]);
  });

  it("rejects competitor and peer comparison clauses", () => {
    const { observations, dropped } = observe(
      "Compared to peers such as Tata Motors, our margins improved while we supply to large customers.",
    );
    expect(observations).toEqual([]);
    expect(dropped).toBeGreaterThan(0);
  });

  it("rejects intra-group edges", () => {
    const { observations } = observe(
      "We supply flat steel to Tata Motors, which accounted for 12% of our revenue.",
      tataSteel,
    );
    expect(observations).toEqual([]);
  });

  it("rejects self edges", () => {
    expect(
      observe("Acme Telecom supplies passive infrastructure to Acme Telecom.").observations,
    ).toEqual([]);
  });

  it("drops analyst questions", () => {
    const { observations } = observe("Analyst: Do you supply to Maruti Suzuki as well?");
    expect(observations).toEqual([]);
  });

  it("classifies a supplier from a sourcing verb", () => {
    const { observations } = observe(
      "We procure raw materials from Tata Steel under an annual contract.",
    );
    expect(observations[0]).toMatchObject({
      supplier: { counterpartyId: 7 },
      customer: { counterpartyId: 1 },
      costBucket: "COGS",
      disclosedBy: "customer",
    });
  });

  it("honours reviewer blocks", () => {
    const blocked = buildAliasMatcher([focal, airtel], [[1, 2]]);
    const result = extractObservations(
      "Bharti Airtel accounted for 69% of our revenue in FY24.",
      blocked,
      {
        focal,
        family: "annual_report",
        period,
      },
    );
    expect(result.observations).toEqual([]);
  });

  it("reports offsets of the clause in the source text", () => {
    const text = "Capacity expanded. We supply towers to Bharti Airtel across 22 circles.";
    const [o] = observe(text).observations;
    expect(o).toBeDefined();
    expect(text.slice(o?.start, o?.end)).toBe(
      "We supply towers to Bharti Airtel across 22 circles.",
    );
  });
});

describe("findMoney", () => {
  it("converts Indian and foreign units to crore", () => {
    expect(
      findMoney("order worth Rs. 1,250 crore and USD 12 million").map((m) => [
        m.currency,
        m.valueCr,
      ]),
    ).toEqual([
      ["INR", 1250],
      ["USD", 1.2],
    ]);
    expect(findMoney("₹ 450 lakh")[0]?.valueCr).toBe(4.5);
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
