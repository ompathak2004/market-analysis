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
});
