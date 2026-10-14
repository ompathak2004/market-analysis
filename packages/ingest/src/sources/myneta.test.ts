import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  decodeMynetaScripts,
  holdingKey,
  mynetaSnapshot,
  parseMynetaCandidate,
  parseMynetaListing,
} from "./myneta.js";

const fixture = (name: string) =>
  readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8");

describe("MyNeta affidavits", () => {
  it("parses the Lok Sabha winners list", () => {
    const list = parseMynetaListing(fixture("myneta-ls-winners.html"), "lok_sabha_2024");
    expect(list).toEqual([
      expect.objectContaining({
        candidateId: "5395",
        name: "Godam Nagesh",
        constituency: "ADILABAD (ST)",
        party: "BJP",
        url: "https://myneta.info/LokSabha2024/candidate.php?candidate_id=5395",
      }),
      expect.objectContaining({ candidateId: "3493", constituency: "AGRA (SC)" }),
    ]);
  });

  it("parses the Rajya Sabha members list", () => {
    const list = parseMynetaListing(fixture("myneta-rs-members.html"), "rajya_sabha");
    expect(list.map((l) => [l.candidateId, l.name, l.party, l.state])).toEqual([
      ["929", "A A Rahim", "CPI(M)", "KERALA"],
      ["907", "Abdul Vahab", "IUML", "KERALA"],
    ]);
  });

  it("decodes the packed movable-assets block", () => {
    const html = decodeMynetaScripts(fixture("myneta-candidate.html"));
    expect(html).not.toContain("eval(function");
    expect(html).toContain("id=movable_assets");
    expect(html).toContain("<span class=desc>HDFC Bank 1500 Shares</span>");
  });

  it("parses a Lok Sabha candidate with share holdings", () => {
    const c = parseMynetaCandidate(fixture("myneta-candidate.html"), "lok_sabha_2024", "118");
    expect(c).toMatchObject({
      name: "HASMUKHBHAI PATEL (H.S.PATEL)",
      party: "Bharatiya Janata Party",
      partyCode: "BJP",
      constituency: "AHMEDABAD EAST",
      state: "GUJARAT",
      age: 63,
      selfProfession: "Business",
      assetsRs: 86470298,
      liabilitiesRs: 13515602,
    });
    expect(c.holdings.map((h) => [h.holder, h.company, h.shares, h.valueRs])).toEqual([
      ["self", "Central Bank", 1000, 59780],
      ["self", "GVK Power", 10000, 97900],
      ["self", "HDFC Bank", 1500, 137850],
      ["spouse", "Tata Motors", 200, 200000],
    ]);
    expect(c.businesses).toEqual([{ holder: "self", description: "Business" }]);
  });

  it("parses a Rajya Sabha declaration of interests", () => {
    const c = parseMynetaCandidate(fixture("myneta-rs-interest.html"), "rajya_sabha", "835");
    expect(c).toMatchObject({
      name: "Indu Bala Goswami",
      constituency: null,
      state: "HIMACHAL PRADESH",
      spouseProfession: null,
      assetsRs: 9294910,
      holdings: [],
    });
    expect(c.businesses).toEqual([
      { holder: "self", description: "Director, Parmarth International School" },
    ]);
  });

  it("snapshots holdings with stable spans", () => {
    const c = parseMynetaCandidate(fixture("myneta-candidate.html"), "lok_sabha_2024", "118");
    const snap = mynetaSnapshot(c);
    const first = c.holdings[2];
    const span = first ? snap.spans.get(holdingKey(first)) : undefined;
    expect(span && JSON.parse(snap.content.slice(span.start, span.end)).company).toBe("HDFC Bank");
    expect(snap.spans.has("profile")).toBe(true);
    expect(mynetaSnapshot(c).content).toBe(snap.content);
  });
});
