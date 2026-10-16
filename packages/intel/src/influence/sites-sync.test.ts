import { describe, expect, it } from "vitest";
import { groundOperatingSites } from "./sites-sync.js";

const text =
  "Manufacturing locations: Hosur in Tamil Nadu, Mysore in Karnataka and Nalagarh in Himachal Pradesh.";
const site = {
  name: "Hosur",
  stateCode: "IN-TN",
  stateName: "Tamil Nadu",
  quote: "Hosur in Tamil Nadu",
};

describe("operating-site grounding", () => {
  it("accepts only the exact site and jurisdiction association", () => {
    const [row] = groundOperatingSites(text, [site]);
    expect(text.slice(row?.start, row?.end)).toBe(site.quote);
    expect(() => groundOperatingSites(text, [{ ...site, stateCode: "IN-KA" }])).toThrow();
    expect(() =>
      groundOperatingSites(text, [
        { ...site, stateName: "Karnataka", stateCode: "IN-KA", quote: text },
      ]),
    ).toThrow();
    expect(() =>
      groundOperatingSites(text, [{ ...site, quote: "Hosur in Tamil Nadu factory" }]),
    ).toThrow();
    expect(() => groundOperatingSites(text, [site, site])).toThrow(/Duplicate/);
  });
});
