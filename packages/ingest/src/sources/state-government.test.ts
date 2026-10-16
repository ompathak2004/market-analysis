import { describe, expect, it } from "vitest";
import {
  parseStateHeads,
  stateDirectoryReviewedOn,
  stateDirectoryText,
} from "./state-government.js";

const states = [
  "Andhra Pradesh",
  "Arunachal Pradesh",
  "Assam",
  "Bihar",
  "Chhattisgarh",
  "Goa",
  "Gujarat",
  "Haryana",
  "Himachal Pradesh",
  "Jharkhand",
  "Karnataka",
  "Kerala",
  "Madhya Pradesh",
  "Maharashtra",
  "Meghalaya",
  "Mizoram",
  "Nagaland",
  "Odisha",
  "Punjab",
  "Tamil Nadu",
];
const directory = states.map((state, i) => `##### Shri Example ${i}\n\n${state}`).join("\n\n");

describe("official state leadership directory", () => {
  it("grounds each state in exact UTF-16 offsets", () => {
    const text = `Example 😀\n\n${directory}`;
    const rows = parseStateHeads(text);
    expect(rows).toHaveLength(20);
    const tn = rows.find((r) => r.stateCode === "IN-TN");
    expect(tn?.headName).toBe("Example 19");
    expect(text.slice(tn?.start, tn?.end)).toBe("##### Shri Example 19\n\nTamil Nadu");
  });
  it("rejects incomplete and conflicting snapshots", () => {
    expect(() => parseStateHeads("# Chief Ministers\nLoading")).toThrow();
    expect(() => parseStateHeads(`${directory}\n\n##### Another Person\n\nTamil Nadu`)).toThrow(
      /duplicate/,
    );
  });
  it("normalizes the rendered official HTML without losing jurisdiction associations", () => {
    const html = states
      .map((state, i) => `<h5 class="profile">Shri Example ${i}</h5><p>${state}</p>`)
      .join("");
    const text = stateDirectoryText(html);
    expect(parseStateHeads(text)).toHaveLength(20);
    expect(text).toContain("##### Example 19\n\nTamil Nadu");
  });
  it("reads the source review date without inventing term dates", () => {
    expect(
      stateDirectoryReviewedOn("Last reviewed and updated on\n\n07\n\nOctober\n\n2026\n\nat 12:35"),
    ).toBe("2026-10-07");
    expect(stateDirectoryReviewedOn(directory)).toBeNull();
  });
});
