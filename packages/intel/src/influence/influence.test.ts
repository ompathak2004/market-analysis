import { describe, expect, it } from "vitest";
import { namesCompatible, normalizeDin, normalizePersonName, personNameKey } from "./normalize.js";
import { CONFIDENCE, resolvePerson } from "./resolve.js";
import {
  edgeStatus,
  isMaterialRpt,
  materialRptThresholdCr,
  rptRelationshipClass,
} from "./rules.js";
import type { PersonCandidate } from "./types.js";

describe("normalizePersonName", () => {
  it("strips honorifics, punctuation and suffixes", () => {
    expect(normalizePersonName("Shri N. Chandrasekaran")).toBe("n chandrasekaran");
    expect(normalizePersonName("Smt. Aarthi  Subramanian")).toBe("aarthi subramanian");
    expect(normalizePersonName("Dr. Pradeep Kumar Khosla Jr.")).toBe("pradeep kumar khosla");
    expect(normalizePersonName("Mr. K.Krithivasan")).toBe("k krithivasan");
    expect(normalizePersonName("Ms Hanne Birgitte Breinbjerg-Sorensen")).toBe(
      "hanne birgitte breinbjerg sorensen",
    );
  });

  it("applies NFKC and keeps a lone honorific-like token", () => {
    expect(normalizePersonName("ＡＢＣ　Ｍｉｓｔｒｙ")).toBe("abc mistry");
    expect(normalizePersonName("Mr")).toBe("mr");
  });

  it("builds an order-insensitive key", () => {
    expect(personNameKey("Natarajan Chandrasekaran")).toBe(
      personNameKey("Chandrasekaran Natarajan"),
    );
  });
});

describe("namesCompatible", () => {
  it("matches initials against full given names", () => {
    expect(namesCompatible("Mr. K Krithivasan", "Kunchitham Krithivasan")).toBe(true);
    expect(namesCompatible("N. Ganapathy Subramaniam", "Natarajan Ganapathy Subramaniam")).toBe(
      true,
    );
  });

  it("rejects different surnames and initial-only overlaps", () => {
    expect(namesCompatible("K Krithivasan", "K Subramanian")).toBe(false);
    expect(namesCompatible("A B", "Anil Bhatia")).toBe(false);
  });
});

describe("normalizeDin", () => {
  it("pads and validates", () => {
    expect(normalizeDin("00121863")).toBe("00121863");
    expect(normalizeDin(121863)).toBe("00121863");
    expect(normalizeDin("-")).toBeNull();
    expect(normalizeDin("123456789")).toBeNull();
    expect(normalizeDin("00000000")).toBeNull();
  });
});

const people: PersonCandidate[] = [
  { id: 1, din: "00121863", normalizedName: "chandrasekaran natarajan" },
  { id: 2, din: "10106739", normalizedName: "kunchitham krithivasan" },
  {
    id: 3,
    din: null,
    normalizedName: "rahul kumar",
    identifiers: [{ scheme: "lok_sabha_member", value: "4321" }],
  },
  { id: 4, din: null, normalizedName: "rahul kumar sharma" },
];

describe("resolvePerson", () => {
  it("prefers DIN over name", () => {
    const r = resolvePerson(
      { name: "Someone Else", din: "121863", source: "structured_primary" },
      people,
    );
    expect(r).toMatchObject({ personId: 1, basis: "din", identifier: true, create: false });
    expect(r.confidence).toBe(CONFIDENCE.structuredIdentifier);
  });

  it("creates a new identity for an unseen DIN instead of merging by name", () => {
    const r = resolvePerson(
      { name: "Kunchitham Krithivasan", din: "99999999", source: "structured_primary" },
      people,
    );
    expect(r).toMatchObject({ personId: null, create: true, basis: "din" });
  });

  it("uses structured member ids before names", () => {
    const r = resolvePerson(
      {
        name: "R. Kumar",
        memberId: { scheme: "lok_sabha_member", value: "4321" },
        source: "structured_primary",
      },
      people,
    );
    expect(r).toMatchObject({ personId: 3, basis: "member_id", confidence: 0.98 });
  });

  it("caps a single-document name match at the review band", () => {
    const r = resolvePerson({ name: "Mr. K Krithivasan", source: "structured_primary" }, people);
    expect(r).toMatchObject({ personId: 2, basis: "name_only", identifier: false });
    expect(r.confidence).toBeLessThanOrEqual(0.8);
  });

  it("raises corroborated name matches to the two-document band", () => {
    const r = resolvePerson(
      { name: "K Krithivasan", source: "primary", independentDocuments: 2 },
      people,
    );
    expect(r).toMatchObject({ personId: 2, basis: "name_corroborated", confidence: 0.95 });
  });

  it("keeps news matches at or below 0.60", () => {
    const r = resolvePerson({ name: "Kunchitham Krithivasan", source: "news" }, people);
    expect(r.confidence).toBeLessThanOrEqual(0.6);
  });

  it("returns ambiguous when several people share a compatible name", () => {
    const r = resolvePerson({ name: "R Kumar", source: "primary" }, [
      { id: 7, din: null, normalizedName: "ravi kumar" },
      { id: 8, din: null, normalizedName: "rakesh kumar" },
    ]);
    expect(r).toMatchObject({
      personId: null,
      create: false,
      basis: "ambiguous",
      candidates: [7, 8],
    });
  });

  it("prefers the single exact name among compatible candidates", () => {
    const r = resolvePerson({ name: "Rahul Kumar", source: "primary" }, people);
    expect(r.personId).toBe(3);
  });
});

describe("edgeStatus", () => {
  it("auto-confirms only structured primary claims with an identifier at 0.95+", () => {
    expect(edgeStatus({ confidence: 0.98, source: "structured_primary", identifier: true })).toBe(
      "confirmed",
    );
    expect(edgeStatus({ confidence: 0.95, source: "structured_primary", identifier: true })).toBe(
      "confirmed",
    );
    expect(edgeStatus({ confidence: 0.98, source: "structured_primary", identifier: false })).toBe(
      "pending",
    );
    expect(edgeStatus({ confidence: 0.95, source: "primary", identifier: true })).toBe("pending");
    expect(edgeStatus({ confidence: 0.94, source: "structured_primary", identifier: true })).toBe(
      "pending",
    );
    expect(edgeStatus({ confidence: 0.6, source: "news", identifier: true })).toBe("pending");
  });
});

describe("material RPT", () => {
  it("uses the lower of 10 crore and 1% of revenue", () => {
    expect(materialRptThresholdCr(null)).toBe(10);
    expect(materialRptThresholdCr(500)).toBe(5);
    expect(materialRptThresholdCr(250_000)).toBe(10);
    expect(isMaterialRpt(10, 250_000)).toBe(true);
    expect(isMaterialRpt(9.99, 250_000)).toBe(false);
    expect(isMaterialRpt(6, 500)).toBe(true);
  });
});

describe("rptRelationshipClass", () => {
  it.each([
    ["Holding Company", "holding"],
    ["Ultimate Holding Company", "holding"],
    ["Promoter", "holding"],
    ["Subsidiaries of Ultimate Holding Company", "group"],
    ["Associates of Holding Company and their subsidiaries", "group"],
    ["Fellow Subsidiary", "group"],
    ["Enterprises over which KMP have significant influence", "group"],
    ["Subsidiaries of TCS", "subsidiary"],
    ["Related parties of Subsidiaries of TCS", "subsidiary"],
    ["Joint Venture", "associate_jv"],
    ["Key Management Personnel", "kmp"],
    ["Relative of Director", "kmp"],
    ["Post Employment Benefit Plans", "employee_benefit"],
    ["Something else", "other"],
    ["", "other"],
  ])("%s -> %s", (input, expected) => {
    expect(rptRelationshipClass(input)).toBe(expected);
  });
});
