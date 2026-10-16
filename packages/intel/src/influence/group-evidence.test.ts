import { describe, expect, it } from "vitest";
import { groupDisclosure } from "./group-evidence.js";

describe("group disclosure grounding", () => {
  it("locates the original filing text for an explicit group affiliation", () => {
    const text = "Our company is part of the Aditya\nBirla Group, with operations across India.";
    const span = groupDisclosure(text, "Aditya Birla Group");
    expect(span).not.toBeNull();
    expect(text.slice(span?.start, span?.end)).toBe(text);
  });

  it("does not invent evidence from a name mention or an unrelated group", () => {
    expect(groupDisclosure("We supply products to Tata Group.", "Tata Group")).toBeNull();
    expect(groupDisclosure("Part of the Birla Group.", "Tata Group")).toBeNull();
    expect(
      groupDisclosure("The Adani Group was part of a religious festival.", "Adani Group"),
    ).toBeNull();
    expect(
      groupDisclosure(
        "Siemens suppliers form part of its agreements and follow Siemens Group conduct.",
        "Siemens Group",
      ),
    ).toBeNull();
    expect(groupDisclosure("ESL became a part of Vedanta Group.", "Vedanta Group")).toBeNull();
  });

  it("requires the affiliation to describe the reporting company", () => {
    for (const text of [
      "A director of the Company, Mr. Adani has been a vital part of the Adani Group since inception.",
      "The Company guarantees CIM Tools, characterized as strategic as part of Motherson Group.",
      "We ensure sustainable production. As part of Tata Group’s Project Aalingana, Tata Power works on biodiversity.",
      "We invest in ESL, which is part of Vedanta Group.",
    ]) {
      const group = /Adani|Motherson|Tata|Vedanta/.exec(text)?.[0];
      expect(groupDisclosure(text, `${group} Group`)).toBeNull();
    }
  });

  it("supports explicit company subjects on either side of the affiliation", () => {
    for (const text of [
      "The Company, being a part of the Tata Group, uses its brand.",
      "Being part of the Tata Group, the Company is committed to sustainability.",
      "Founded decades ago and part of the Tata Group, we bring our heritage.",
      "As part of the Tata Group, a global institution that upholds community well-being, we are committed to social responsibility.",
      "We, at Tata Consumer Products, feel proud to be part of Tata Group, founded by Jamshedji Tata.",
      "Our company is a Tata Group company.",
      "Tata Group - Promoter group entity contributed through equity shares.",
    ]) {
      expect(groupDisclosure(text, "Tata Group")).not.toBeNull();
    }
  });
});
