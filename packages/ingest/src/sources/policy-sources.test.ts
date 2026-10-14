import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { joinPages } from "../documents.js";
import { bondKey, matchBonds, parseBondRows } from "./eci-bonds.js";
import { parseGazetteNotification } from "./egazette.js";
import { parsePibPosted, parsePibRelease, parsePibRss } from "./pib.js";
import { policySnapshot } from "./policy-doc.js";
import { parsePrsBill, parsePrsBillList } from "./prs.js";

const fixture = (name: string) =>
  readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8");

describe("PIB", () => {
  it("parses the English RSS feed", () => {
    const items = parsePibRss(fixture("pib-rss.xml"));
    expect(items).toHaveLength(3);
    expect(items[0]).toEqual({
      prid: "2323264",
      title:
        "Cabinet approves continuation of the National Social Assistance Programme for five years from 2026-27 to 2030-31",
    });
  });

  it("parses a release page", () => {
    const doc = parsePibRelease(fixture("pib-release.html"), "2323218");
    expect(doc).toMatchObject({
      source: "pib",
      externalId: "2323218",
      ministry: "Prime Minister's Office",
      stage: "release",
      url: "https://www.pib.gov.in/PressReleaseIframePage.aspx?PRID=2323218&reg=3&lang=1",
    });
    expect(doc.title).toMatch(/^PM to Inaugurate and Dedicate Five Development Projects/);
    expect(doc.publishedAt.toISOString()).toBe("2026-10-14T09:45:00.000Z");
    expect(doc.text).toMatch(/^Prime Minister Shri Narendra Modi will inaugurate/);
    expect(parsePibPosted("Posted On: 1 JAN 2026 12:05AM by PIB Delhi")?.toISOString()).toBe(
      "2025-12-31T18:35:00.000Z",
    );
  });

  it("snapshots a policy document with title, ministry and text spans", () => {
    const doc = parsePibRelease(fixture("pib-release.html"), "2323218");
    const snap = policySnapshot(doc, 1);
    const span = snap.spans.get("ministry");
    expect(span && JSON.parse(snap.content.slice(span.start, span.end)).value).toBe(
      "Prime Minister's Office",
    );
    expect([...snap.spans.keys()].sort()).toEqual(["ministry", "stage", "text", "title"]);
  });
});

describe("PRS bill track", () => {
  it("parses the bill list", () => {
    const list = parsePrsBillList(fixture("prs-billtrack.html"));
    expect(list.map((b) => [b.slug, b.status])).toEqual([
      ["foreign-contribution-regulation-amendment-rules-2026", "Rules"],
      ["the-national-co-operative-development-corporation-amendment-bill-2026", "Passed"],
      ["the-mines-and-minerals-development-and-regulation-amendment-bill-2026", "Passed"],
    ]);
  });

  it("parses a bill page with its latest stage", () => {
    const slug = "the-mines-and-minerals-development-and-regulation-amendment-bill-2026";
    const doc = parsePrsBill(fixture("prs-bill.html"), slug);
    expect(doc).toMatchObject({
      source: "prs",
      externalId: slug,
      title: "The Mines and Minerals (Development and Regulation) Amendment Bill, 2026",
      ministry: "Mines",
      stage: "Passed (Lok Sabha)",
      url: `https://prsindia.org/billtrack/${slug}`,
    });
    expect(doc.publishedAt.toISOString()).toBe("2026-08-11T18:30:00.000Z");
    expect(doc.text).toMatch(/introduced in Lok Sabha on August 10, 2026/);
  });
});

describe("eGazette", () => {
  const text = [
    "REGD. No. D. L.-33004/99 EXTRAORDINARY PART II—Section 3—Sub-section (i)",
    "No. 612] NEW DELHI, FRIDAY, OCTOBER 10, 2026",
    "MINISTRY OF COAL",
    "NOTIFICATION",
    "New Delhi, the 9th October, 2026",
    "G.S.R. 745(E).—In exercise of the powers conferred by section 13 of the Mines and Minerals",
    "(Development and Regulation) Act, 1957, the Central Government hereby makes the following rules, namely:—",
    "1. Short title and commencement.—(1) These rules may be called the Coal Block Allocation (Amendment) Rules, 2026.",
  ].join("\n");

  it("parses a gazette notification", () => {
    const doc = parseGazetteNotification(text, "https://egazette.gov.in/WriteReadData/2026/1.pdf");
    expect(doc).toMatchObject({
      source: "egazette",
      externalId: "2026:GSR 745(E)",
      title: "Coal Block Allocation (Amendment) Rules, 2026",
      ministry: "Ministry of Coal",
      stage: "Notification",
    });
    expect(doc?.publishedAt.toISOString()).toBe("2026-10-08T18:30:00.000Z");
    expect(doc?.text).toMatch(/^G\.S\.R\. 745\(E\)/);
  });

  it("returns null without a notification number", () => {
    expect(
      parseGazetteNotification("MINISTRY OF COAL New Delhi, the 9th October, 2026", "x"),
    ).toBeNull();
  });
});

describe("ECI electoral bonds", () => {
  const purchases = joinPages([
    [
      "Sr No. Reference No (URN) Journal Date Date of Purchase Date of Expiry Name of the Purchaser Prefix Bond Number Denominations Issue Branch Code Issue Teller Status",
      "1 00001201904120000001166 12/Apr/2019 12/Apr/2019 26/Apr/2019 ALPHA STEEL LIMITED TL 11448 1,00,00,000 00001 00000011 Paid",
      "2 00001201904120000001167 12/Apr/2019 12/Apr/2019 26/Apr/2019 BETA POWER",
      "PRIVATE LIMITED TL 11449 10,00,000 00001 00000011 Paid",
    ].join("\n"),
    [
      "3 00001201904120000001168 12/Apr/2019 13/Apr/2019 27/Apr/2019 GAMMA TRADERS OC 775 1,000 00800 00000012 Paid",
      "4 00001201904120000001169 12/Apr/2019 13/Apr/2019 27/Apr/2019 DELTA FOODS OC 775 1,000 00800 00000012 Paid",
      "5 00001201904120000001170 12/Apr/2019 14/Apr/2019 28/Apr/2019 EPSILON LTD OC 900 10,000 00800 00000012 Expired",
    ].join("\n"),
  ]);
  const redemptions = joinPages([
    [
      "Sr No. Date of Encashment Name of the Political Party Account no. of Political Party Prefix Bond Number Denominations Pay Branch Code Pay Teller",
      "1 15/Apr/2019 PARTY ONE *******5199 TL 11448 1,00,00,000 00800 2770121",
      "2 16/Apr/2019 PARTY TWO *******1234 TL 11449 10,00,000 00800 2770121",
      "3 16/Apr/2019 PARTY TWO *******1234 OC 775 1,000 00800 2770121",
    ].join("\n"),
  ]);

  it("parses purchase and redemption rows across pages and wrapped names", () => {
    const bought = parseBondRows(purchases, "purchase");
    expect(bought.map((r) => [r.name, bondKey(r), r.date, r.page])).toEqual([
      ["ALPHA STEEL LIMITED", "TL:11448:10000000", "2019-04-12", 1],
      ["BETA POWER PRIVATE LIMITED", "TL:11449:1000000", "2019-04-12", 1],
      ["GAMMA TRADERS", "OC:775:1000", "2019-04-13", 2],
      ["DELTA FOODS", "OC:775:1000", "2019-04-13", 2],
      ["EPSILON LTD", "OC:900:10000", "2019-04-14", 2],
    ]);
    const first = bought[0];
    expect(first && purchases.text.slice(first.start, first.end)).toMatch(
      /^1 0000120190412.*Paid$/,
    );
    const redeemed = parseBondRows(redemptions, "redemption");
    expect(redeemed.map((r) => [r.name, bondKey(r)])).toEqual([
      ["PARTY ONE", "TL:11448:10000000"],
      ["PARTY TWO", "TL:11449:1000000"],
      ["PARTY TWO", "OC:775:1000"],
    ]);
  });

  it("matches one-to-one and leaves duplicate bond keys unmatched", () => {
    const result = matchBonds(
      parseBondRows(purchases, "purchase"),
      parseBondRows(redemptions, "redemption"),
    );
    expect(result.pairs.map((p) => [p.purchase.name, p.redemption.name])).toEqual([
      ["ALPHA STEEL LIMITED", "PARTY ONE"],
      ["BETA POWER PRIVATE LIMITED", "PARTY TWO"],
    ]);
    expect(result.ambiguous).toEqual(["OC:775:1000"]);
    expect(result.unmatchedPurchases).toBe(3);
    expect(result.unmatchedRedemptions).toBe(1);
  });
});
