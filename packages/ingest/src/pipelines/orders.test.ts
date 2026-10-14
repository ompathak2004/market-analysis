import { describe, expect, it } from "vitest";
import { type AliasEntry, buildAliasMatcher } from "../extract/relationships.js";
import {
  isOrderAnnouncement,
  nameAt,
  orderConfidence,
  orderPeriod,
  parseOrderClaims,
} from "./orders.js";

function entry(
  counterpartyId: number,
  name: string,
  opts: Partial<Omit<AliasEntry, "counterpartyId" | "name">> = {},
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

const knr = entry(1, "KNR Constructions Limited", {
  companyId: 11,
  phrases: ["KNR Constructions"],
});
const nhai = entry(2, "National Highways Authority of India", {
  kind: "government",
  phrases: ["NHAI", "National Highways Authority of India"],
});
const powerGrid = entry(3, "Power Grid Corporation of India Limited", {
  companyId: 13,
  phrases: ["Power Grid Corporation of India", "Power Grid", "PGCIL"],
  symbols: ["POWERGRID"],
});
const tataProjects = entry(4, "Tata Projects Limited", {
  companyId: 14,
  phrases: ["Tata Projects"],
  groupKeys: ["tata"],
});
const tataSteel = entry(5, "Tata Steel Limited", {
  companyId: 15,
  phrases: ["Tata Steel"],
  groupKeys: ["tata"],
});
const matcher = buildAliasMatcher([knr, nhai, powerGrid, tataProjects, tataSteel]);

describe("isOrderAnnouncement", () => {
  it("accepts order-win subjects", () => {
    for (const subject of [
      "Bagging of order from NHAI worth Rs 1,248.80 crore",
      "Announcement under Regulation 30 (LODR)-Award of Order / Receipt of Order",
      "Receipt of Letter of Award (LoA) for EPC project",
      "Company secures new export orders",
      "Emerged as L1 bidder for Mumbai Metro Line 6",
    ]) {
      expect(isOrderAnnouncement({ subject, categoryKey: null })).toBe(true);
    }
  });

  it("rejects routine and legal filings", () => {
    for (const subject of [
      "Order passed by the Hon'ble National Company Law Tribunal",
      "Receipt of GST demand order",
      "Intimation of trading window closure",
      "Appointment of Mr. A as Managing Director under contract of employment",
      "Board Meeting Intimation for Financial Results",
    ]) {
      expect(isOrderAnnouncement({ subject, categoryKey: null })).toBe(false);
    }
    expect(isOrderAnnouncement({ subject: "Press Release", categoryKey: "order_win" })).toBe(true);
  });
});

describe("parseOrderClaims", () => {
  it("reads a curated government awarder, value and execution period", () => {
    const text = `Receipt of Letter of Award from National Highways Authority of India
KNR Constructions Limited has informed the Exchange that the Company has received Letter of Award (LoA) from National Highways Authority of India for construction of four-lane highway on EPC mode for a contract value of Rs. 1,248.80 crore with a completion period of 24 months.`;
    const { claims } = parseOrderClaims(text, matcher, knr);
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      awarder: { entry: { counterpartyId: 2 }, kind: "government" },
      money: { currency: "INR", valueCr: 1248.8 },
      months: 24,
      status: "awarded",
      costBucket: "CAPEX",
    });
    const claim = claims[0];
    expect(claim && text.slice(claim.start, claim.end)).toContain(
      "National Highways Authority of India",
    );
  });

  it("reads a listed awarder with a foreign-currency value", () => {
    const text = `Receipt of order from Power Grid Corporation of India Limited
The Company has received purchase orders worth USD 25 million from Power Grid Corporation of India Limited for supply of 765 kV transformers.`;
    const { claims } = parseOrderClaims(text, matcher, knr);
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      awarder: { entry: { counterpartyId: 3 } },
      money: { currency: "USD", valueCr: 2.5 },
      costBucket: "CAPEX",
    });
  });

  it("captures an unknown government awarder and a pending L1 status", () => {
    const text =
      "Emerged as L1 bidder. The Company has emerged as the lowest bidder for a contract from Mumbai Metro Rail Corporation Limited worth Rs 2,100 crore.";
    const { claims } = parseOrderClaims(text, matcher, knr);
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      awarder: { entry: null, name: "Mumbai Metro Rail Corporation Limited", kind: "government" },
      money: { valueCr: 2100 },
      status: "pending",
    });
  });

  it("marks cancelled work orders with a private awarder", () => {
    const text =
      "Cancellation of work order. The work order received from Hindustan Zinc Limited for Rs 85 crore has been cancelled by the client.";
    const { claims } = parseOrderClaims(text, matcher, knr);
    expect(claims[0]).toMatchObject({
      awarder: { entry: null, name: "Hindustan Zinc Limited", kind: "private" },
      status: "cancelled",
      costBucket: "UNKNOWN",
      money: { valueCr: 85 },
    });
  });

  it("skips generic, self and same-group awarders", () => {
    expect(
      parseOrderClaims(
        "The Company has bagged an order from a leading global OEM worth Rs 300 crore.",
        matcher,
        knr,
      ).claims,
    ).toEqual([]);
    expect(
      parseOrderClaims(
        "Tata Projects has received an order from Tata Steel for a coke oven battery.",
        matcher,
        tataProjects,
      ).claims,
    ).toEqual([]);
    expect(
      parseOrderClaims(
        "Order received by KNR Constructions from NHAI for road works.",
        matcher,
        knr,
      ).claims.map((c) => c.awarder.entry?.counterpartyId),
    ).toEqual([2]);
  });
});

describe("nameAt", () => {
  it("stops at value words and keeps joiners inside names", () => {
    const text = "from Ministry of Defence worth Rs 500 crore";
    expect(nameAt(text, 5)).toBe("Ministry of Defence");
    expect(nameAt("from Rs 100 crore", 5)).toBeNull();
    expect(nameAt("from Leading OEM", 5)).toBeNull();
  });
});

describe("orderPeriod and orderConfidence", () => {
  it("dates the execution window from publication", () => {
    expect(orderPeriod(new Date("2024-05-10T09:00:00Z"), 18)).toEqual({
      start: "2024-05-10",
      end: "2025-11-10",
      fiscalYear: 2025,
    });
    expect(orderPeriod(new Date("2024-02-01T09:00:00Z"), null)).toEqual({
      start: "2024-02-01",
      end: null,
      fiscalYear: 2024,
    });
  });

  it("rewards known awarders with values and penalises pending awards", () => {
    const base = {
      money: null,
      months: null,
      costBucket: "UNKNOWN" as const,
      claim: "x",
      start: 0,
      end: 1,
    };
    expect(
      orderConfidence("order_filing", {
        ...base,
        awarder: { entry: nhai, name: nhai.name, kind: "government" },
        money: { amount: 1, currency: "INR", valueCr: 1, start: 0, end: 1 },
        status: "awarded",
      }),
    ).toBe(0.85);
    expect(
      orderConfidence("announcement_metadata", {
        ...base,
        awarder: { entry: null, name: "Some Buyer", kind: "private" },
        status: "pending",
      }),
    ).toBe(0.55);
  });
});
