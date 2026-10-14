import { describe, expect, it } from "vitest";
import { familyOf, JOB_TYPES } from "./contracts.js";
import { FAMILY_INVALIDATIONS } from "./invalidation.js";

const READ_MODEL_PREFIXES = [
  "search:",
  "company:",
  "quote:",
  "prices:",
  "movers:",
  "financials:",
  "signals:",
  "leaderboard:",
  "supply-chain:",
  "announcements:",
  "analysts:",
  "research:",
  "insights:",
  "feed:",
  "market-brief:",
  "travel:",
  "logistics:",
  "altdata:",
  "influence:",
];

const FAMILIES_WITHOUT_READ_MODELS = ["documents"];

describe("family cache invalidation", () => {
  it("covers every job family that feeds a read model with known prefixes", () => {
    const families = new Set(JOB_TYPES.map(familyOf).filter((f) => f !== null));
    for (const family of families) {
      if (FAMILIES_WITHOUT_READ_MODELS.includes(family)) continue;
      expect(FAMILY_INVALIDATIONS[family], family).toBeDefined();
    }
    for (const [family, prefixes] of Object.entries(FAMILY_INVALIDATIONS)) {
      expect(families.has(family), family).toBe(true);
      expect(prefixes.length).toBeGreaterThan(0);
      for (const p of prefixes) expect(READ_MODEL_PREFIXES).toContain(p);
    }
  });

  it("refreshes brief inputs after jobs that change them", () => {
    for (const family of ["prices", "fundamentals", "announcements", "moneycontrol", "triage"]) {
      expect(FAMILY_INVALIDATIONS[family]).toContain("insights:");
    }
    expect(FAMILY_INVALIDATIONS["aircraft-sample"]).toContain("travel:");
  });
});
