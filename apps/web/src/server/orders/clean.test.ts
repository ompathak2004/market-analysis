import { describe, expect, it } from "vitest";
import { cleanOrders, type RawOrder } from "./clean";

const base: RawOrder = {
  observationId: 1,
  announcementId: 10,
  family: "order_filing",
  publishedAt: "2026-08-04",
  supplierSymbol: "BEL",
  supplierName: "Bharat Electronics Ltd.",
  buyerName: "Ministry of Defence",
  buyerKind: "government",
  buyerSymbol: null,
  valueCr: 619,
  currency: "INR",
  orderStatus: "awarded",
  confidence: 0.85,
  claim: "BEL has received orders worth Rs 619 crore from the Ministry of Defence.",
  subject: "Bagging/Receiving of orders/contracts",
  url: "https://example.test/a.pdf",
};

describe("cleanOrders", () => {
  it("reads L&T size bands instead of the extracted number", () => {
    const { orders } = cleanOrders([
      {
        ...base,
        supplierSymbol: "LT",
        supplierName: "Larsen & Toubro Ltd.",
        buyerName: "ADNOC Offshore We",
        valueCr: 3200,
        currency: "USD",
        claim: "L&T Wins Ultra-Mega* Order from ADNOC Offshore",
      },
    ]);
    expect(orders[0]?.value).toMatchObject({ low: 15_000, high: null, band: "Ultra-mega" });
    expect(orders[0]?.buyer).toBe("ADNOC");
  });

  it("drops tax orders, year-to-date totals and second reads of one filing", () => {
    const { orders, excluded } = cleanOrders([
      base,
      { ...base, observationId: 2, family: "announcement_metadata" },
      {
        ...base,
        observationId: 3,
        announcementId: 11,
        buyerName: "Assistant Commissioner",
        claim: "Receipt of Order-in-Original raising a GST demand",
      },
      {
        ...base,
        observationId: 4,
        announcementId: 12,
        supplierSymbol: "KEC",
        supplierName: "KEC International Ltd.",
        buyerName: "T&D",
        valueCr: 13_500,
        claim: "With these wins, our YTD order intake has crossed Rs. 13,500 crores",
      },
    ]);
    expect(orders.map((o) => o.id)).toEqual(["o1"]);
    expect(excluded.map((x) => x.reason).sort()).toEqual([
      "same filing read twice",
      "tax or regulatory order, not a purchase order",
      "year-to-date or order-book total, not a new order",
    ]);
  });

  it("keeps foreign-currency values out of rupee totals", () => {
    const { orders } = cleanOrders([{ ...base, valueCr: 1.49, currency: "USD" }]);
    expect(orders[0]?.value).toBeNull();
    expect(orders[0]?.foreignCurrency).toBe("USD");
  });
});
