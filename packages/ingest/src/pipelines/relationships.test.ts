import { describe, expect, it } from "vitest";
import { periodEndFromLabel } from "./relationships.js";

describe("periodEndFromLabel", () => {
  it("returns the last day of a labelled month so it matches fundamentals rows", () => {
    expect(periodEndFromLabel("Annual Report Mar 2025")).toBe("2025-03-31");
    expect(periodEndFromLabel("Concall Jun 2024")).toBe("2024-06-30");
    expect(periodEndFromLabel("Feb 2024")).toBe("2024-02-29");
  });

  it("falls back to the fiscal-year end for FY labels", () => {
    expect(periodEndFromLabel("FY25 annual report")).toBe("2025-03-31");
  });
});
