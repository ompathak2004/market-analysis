import {
  lineSnapshot,
  type MynetaListing,
  type ParliamentMember,
  readLineSnapshot,
  sectorsForIndustry,
  sectorsForMinistry,
} from "@ma/ingest";
import { describe, expect, it } from "vitest";
import { eventInputHash, type OfficeState, officeChanges } from "./events.js";
import { acceptLlmTags, companyNamePattern, type PolicyText, ruleTags } from "./policy.js";
import { quoteSpan } from "./policy-sync.js";
import { matchMynetaListing, officeClaims, rupeesToCrore } from "./politics.js";
import { CONFIDENCE, confidenceFor } from "./resolve.js";
import { edgeStatus } from "./rules.js";
import type { SourceKind } from "./types.js";

const member = (over: Partial<ParliamentMember>): ParliamentMember => ({
  house: "lok_sabha",
  memberId: "5001",
  name: "Asha Verma",
  party: "Example Party",
  partyCode: "EXP",
  constituency: "Pune",
  state: "Maharashtra",
  birthYear: 1970,
  fromDate: "2024-06-04",
  toDate: null,
  ...over,
});

const listing = (over: Partial<MynetaListing>): MynetaListing => ({
  election: "lok_sabha_2024",
  candidateId: "100",
  name: "ASHA VERMA",
  party: "EXP",
  constituency: "PUNE",
  state: "MAHARASHTRA",
  url: "https://myneta.info/LokSabha2024/candidate.php?candidate_id=100",
  ...over,
});

describe("confidence bands", () => {
  it("maps identifiers, document counts and inference to the plan bands", () => {
    expect(confidenceFor("member_id", "structured_primary")).toBe(0.98);
    expect(confidenceFor("name_corroborated", "primary", 2)).toBe(0.95);
    expect(confidenceFor("name_corroborated", "primary", 1)).toBe(0.8);
    expect(confidenceFor("member_id", "news")).toBe(0.6);
    expect(confidenceFor("name_corroborated", "inference")).toBe(0.6);
  });

  it("auto-confirms only structured identifiers at 0.95 or more", () => {
    const status = (confidence: number, source: SourceKind, identifier: boolean) =>
      edgeStatus({ confidence, source, identifier });
    expect(status(CONFIDENCE.structuredIdentifier, "structured_primary", true)).toBe("confirmed");
    expect(status(CONFIDENCE.twoPrimaryDocuments, "primary", true)).toBe("pending");
    expect(status(CONFIDENCE.singleDocumentName, "primary", false)).toBe("pending");
    expect(status(CONFIDENCE.newsOrInference, "inference", false)).toBe("pending");
  });
});

describe("officeClaims", () => {
  it("emits one seat per member and a minister claim only for a known member", () => {
    const claims = officeClaims({
      members: [member({}), member({ house: "rajya_sabha", memberId: "77", constituency: null })],
      ministers: [
        {
          house: "lok_sabha",
          memberId: "5001",
          name: "Asha Verma",
          rank: "minister_of_state",
          position: "Ministry of Power",
        },
        { house: "lok_sabha", memberId: "9999", name: "Unknown", rank: "minister", position: "" },
      ],
    });
    expect(claims.map((c) => [c.key, c.office, c.label])).toEqual([
      ["parliament:ls:5001", "mp_lok_sabha", "MP, Lok Sabha (Pune)"],
      ["parliament:rs:77", "mp_rajya_sabha", "MP, Rajya Sabha (Maharashtra)"],
      ["parliament:minister:ls:5001", "minister", "Minister of State, Ministry of Power"],
    ]);
    expect(claims[0]?.identifier).toEqual({ scheme: "lok_sabha_member", value: "5001" });
    expect(claims[2]?.fromDate).toBeNull();
  });
});

describe("matchMynetaListing", () => {
  it("matches a Lok Sabha member by constituency and a shared name token", () => {
    const hit = listing({ constituency: "PUNE (SC)" });
    expect(matchMynetaListing(member({ constituency: "Pune (SC)" }), [hit])).toBe(hit);
    expect(matchMynetaListing(member({}), [listing({ name: "RAVI KUMAR" })])).toBeNull();
  });

  it("refuses ambiguous constituency hits and the wrong election", () => {
    expect(
      matchMynetaListing(member({}), [listing({}), listing({ candidateId: "101" })]),
    ).toBeNull();
    expect(matchMynetaListing(member({}), [listing({ election: "rajya_sabha" })])).toBeNull();
  });

  it("matches a Rajya Sabha member by state and compatible name", () => {
    const hit = listing({ election: "rajya_sabha", constituency: null });
    expect(matchMynetaListing(member({ house: "rajya_sabha", constituency: null }), [hit])).toBe(
      hit,
    );
  });

  it("converts declared rupees to crore", () => {
    expect(rupeesToCrore(125_000_000)).toBe("12.50");
    expect(rupeesToCrore(null)).toBeNull();
  });
});

describe("policy tagging", () => {
  const doc: PolicyText = {
    title: "Cabinet approves viability gap funding for Example Power Grid storage",
    ministry: "Ministry of Power",
    text: "The Union Cabinet approved viability gap funding for battery energy storage systems.",
  };

  it("maps ministries and NSE industries to policy sectors", () => {
    expect(sectorsForMinistry("Ministry of Petroleum & Natural Gas")).toEqual(["oil_gas"]);
    expect(sectorsForMinistry("Ministry of Culture")).toEqual([]);
    expect(sectorsForIndustry("Oil Gas & Consumable Fuels")).toContain("oil_gas");
    expect(sectorsForIndustry(null)).toEqual([]);
  });

  it("tags the ministry sector as confirmable and a named company as pending", () => {
    const tags = ruleTags(doc, [
      { id: 1, normalizedName: "example power grid" },
      { id: 2, normalizedName: "abb" },
      { id: 3, normalizedName: "absent industries" },
    ]);
    expect(tags).toEqual([
      expect.objectContaining({
        target: { sectorKey: "power" },
        confidence: CONFIDENCE.twoPrimaryDocuments,
        source: "structured_primary",
        identifier: true,
        field: "ministry",
      }),
      expect.objectContaining({
        target: { companyId: 1 },
        confidence: CONFIDENCE.singleDocumentName,
        identifier: false,
        field: "title",
        quote: "Example Power Grid",
      }),
    ]);
    expect(companyNamePattern("abb")).toBeNull();
    expect(companyNamePattern("example power")?.test("example-power ltd")).toBe(true);
    expect(companyNamePattern("example power")?.test("counterexample power")).toBe(false);
  });

  it("keeps only LLM sectors that are known, new and quoted from the policy text", () => {
    const tags = acceptLlmTags(
      doc,
      {
        tags: [
          { sector: "power", quote: "battery energy storage systems" },
          { sector: "unknown_sector", quote: "battery energy storage systems" },
          { sector: "coal_mining", quote: "coal blocks will be auctioned next year" },
          { sector: "defence", quote: "short" },
          { sector: "it_telecom", quote: "viability gap funding for battery energy" },
        ],
      },
      new Set(["power"]),
    );
    expect(tags).toEqual([
      expect.objectContaining({
        target: { sectorKey: "it_telecom" },
        basis: "llm",
        confidence: CONFIDENCE.newsOrInference,
        source: "inference",
        field: "text",
      }),
    ]);
  });

  it("locates a quote inside its snapshot line, including JSON-escaped whitespace", () => {
    const snap = lineSnapshot(
      { source: "pib" },
      [{ id: "a" }],
      () => "doc",
      () => ({
        ministry: "Ministry of Power",
        text: "Cabinet approved\nviability gap funding",
      }),
    );
    const line = readLineSnapshot(snap.content).get("doc");
    const hit = quoteSpan(snap.content, line, "text", "approved viability gap");
    expect(hit && snap.content.slice(hit.start, hit.end)).toBe("approved\\nviability gap");
    expect(quoteSpan(snap.content, line, "ministry", "x")).toEqual(snap.spans.get("doc"));
    expect(quoteSpan(snap.content, line, "text", "not present")).toBeUndefined();
    expect(quoteSpan(snap.content, undefined, "text", "approved")).toBeUndefined();
  });
});

describe("events", () => {
  const office = (key: string, status: OfficeState["status"]): OfficeState => ({
    key,
    personId: 1,
    label: key,
    status,
  });

  it("reports offices gained and lost between reads", () => {
    const res = officeChanges(
      [office("a", "current"), office("b", "current"), office("c", "past")],
      [office("a", "current"), office("c", "current"), office("d", "current")],
    );
    expect(res.gained.map((o) => o.key)).toEqual(["c", "d"]);
    expect(res.lost.map((o) => o.key)).toEqual(["b"]);
  });

  it("hashes event keys deterministically", () => {
    expect(eventInputHash(["office", 1, null])).toBe(eventInputHash(["office", 1, null]));
    expect(eventInputHash(["office", 1, null])).not.toBe(eventInputHash(["office", 2, null]));
  });
});
