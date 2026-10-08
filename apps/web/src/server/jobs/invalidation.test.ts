import { describe, expect, it, vi } from "vitest";
import type { AppContext } from "../context";
import { getJob, jobNames, runJob } from "./index";
import { JOB_INVALIDATIONS } from "./invalidation";

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
];

function fakeContext(invalidated: string[]): AppContext {
  const chain = {
    values: () => chain,
    returning: async () => [{ id: 1 }],
    set: () => chain,
    where: async () => undefined,
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return {
    redis: { set: async () => "OK", eval: async () => 1 },
    db: { insert: () => chain, update: () => chain },
    api: {
      invalidatePrefix: async (p: string) => {
        invalidated.push(p);
      },
    },
    logger,
  } as unknown as AppContext;
}

describe("job cache invalidation", () => {
  it("covers every registered job with known read-model prefixes", () => {
    expect(Object.keys(JOB_INVALIDATIONS).sort()).toEqual(jobNames().sort());
    for (const prefixes of Object.values(JOB_INVALIDATIONS)) {
      expect(prefixes.length).toBeGreaterThan(0);
      for (const p of prefixes) expect(READ_MODEL_PREFIXES).toContain(p);
    }
  });

  it("refreshes brief inputs after jobs that change them", () => {
    for (const job of ["prices", "fundamentals", "announcements", "moneycontrol", "triage"]) {
      expect(JOB_INVALIDATIONS[job]).toContain("insights:");
    }
    expect(JOB_INVALIDATIONS["aircraft-sample"]).toContain("travel:");
  });

  it("invalidates after a job that fails part-way", async () => {
    const invalidated: string[] = [];
    const outcome = await runJob(fakeContext(invalidated), "prices", 1_000, async () => {
      throw new Error("boom");
    });
    expect(outcome.status).toBe("failed");
    expect(invalidated).toEqual([...(JOB_INVALIDATIONS.prices ?? [])]);
    expect(getJob("prices")).toBeDefined();
  });
});
