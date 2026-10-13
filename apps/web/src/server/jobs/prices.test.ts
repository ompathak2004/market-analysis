import type { PriceWindowResult } from "@ma/ingest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppContext } from "../context";
import type { JobRun } from "./run";

const jobs = vi.hoisted(() => ({
  markSynced: vi.fn<(db: unknown, job: string, id: number) => Promise<void>>(async () => undefined),
  markFailed: vi.fn<(db: unknown, job: string, id: number, err: unknown) => Promise<void>>(
    async () => undefined,
  ),
  pickBatch: vi.fn<() => Promise<number[]>>(async () => [1, 2, 3]),
}));
const ingest = vi.hoisted(() => ({ syncCompanyPrices: vi.fn() }));

vi.mock("@ma/jobs", async (importActual) => ({
  ...(await importActual<typeof import("@ma/jobs")>()),
  ...jobs,
}));
vi.mock("@ma/ingest", async (importActual) => ({
  ...(await importActual<typeof import("@ma/ingest")>()),
  syncCompanyPrices: ingest.syncCompanyPrices,
}));

const { forEachCompany } = await import("./batch");
const { coreJobs } = await import("./core");

function result(partial: Partial<PriceWindowResult>): PriceWindowResult {
  return {
    status: "written",
    inserted: 1,
    updated: 0,
    unchanged: 0,
    rejected: 0,
    events: 0,
    newActions: 0,
    gaps: 0,
    missingSessions: 0,
    windowMissing: 0,
    windowExpected: 20,
    latestCovered: true,
    source: "yahoo",
    sourceStatus: "ok",
    quality: "complete",
    detail: null,
    ...partial,
  };
}

function fakeRun(): JobRun {
  const ctx = {
    db: {},
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    config: { DATA_UNIVERSE: "NIFTY50", SCRAPE_CONCURRENCY: 2 },
  } as unknown as AppContext;
  return {
    ctx,
    name: "prices",
    deadline: Date.now() + 60_000,
    signal: new AbortController().signal,
    remainingMs: () => 60_000,
    expired: () => false,
  };
}

beforeEach(() => {
  jobs.markSynced.mockClear();
  jobs.markFailed.mockClear();
  ingest.syncCompanyPrices.mockReset();
});

describe("forEachCompany isSynced gate", () => {
  it("marks synced by default and only when isSynced agrees otherwise", async () => {
    await forEachCompany(fakeRun(), [1, 2], 2, async (id) => ({ n: id }));
    expect(jobs.markSynced).toHaveBeenCalledTimes(2);

    jobs.markSynced.mockClear();
    const stats = await forEachCompany(fakeRun(), [1, 2, 3], 2, async (id) => ({ n: id }), {
      isSynced: (r) => r.n === 2,
    });
    expect(jobs.markSynced).toHaveBeenCalledTimes(1);
    expect(jobs.markSynced).toHaveBeenCalledWith({}, "prices", 2);
    expect(jobs.markFailed).not.toHaveBeenCalled();
    expect(stats).toMatchObject({ items: 3, failed: 0, skipped: 0, n: 6 });
  });

  it("records a failure and never marks synced when the item throws", async () => {
    const stats = await forEachCompany(
      fakeRun(),
      [1, 2],
      2,
      async (id) => {
        if (id === 1) throw new Error("boom");
        return { n: id };
      },
      { isSynced: () => true },
    );
    expect(jobs.markSynced).toHaveBeenCalledTimes(1);
    expect(jobs.markSynced).toHaveBeenCalledWith({}, "prices", 2);
    expect(jobs.markFailed).toHaveBeenCalledTimes(1);
    expect(jobs.markFailed.mock.calls[0]?.slice(1, 3)).toEqual(["prices", 1]);
    expect(stats).toMatchObject({ items: 2, failed: 1 });
  });
});

describe("legacy prices job", () => {
  const prices = coreJobs.find((j) => j.name === "prices");
  if (!prices) throw new Error("prices job missing");

  it("marks synced only for complete windows that reach the latest session", async () => {
    const byId: Record<number, PriceWindowResult> = {
      1: result({}),
      2: result({ latestCovered: false }),
      3: result({ sourceStatus: "identity_mismatch", status: "identity_mismatch", inserted: 0 }),
    };
    ingest.syncCompanyPrices.mockImplementation(async (_ctx: unknown, id: number) => byId[id]);
    const stats = await prices.run(fakeRun());
    expect(jobs.markSynced).toHaveBeenCalledTimes(1);
    expect(jobs.markSynced).toHaveBeenCalledWith({}, "prices", 1);
    expect(jobs.markFailed).not.toHaveBeenCalled();
    expect(stats).toMatchObject({ items: 3, failed: 0, synced: 1 });
  });

  it("fails the company on incomplete, empty, invalid and calendar-pending windows", async () => {
    jobs.pickBatch.mockResolvedValueOnce([1, 2, 3, 4, 5]);
    const byId: Record<number, PriceWindowResult> = {
      1: result({ status: "incomplete", windowMissing: 3, detail: "3 sessions missing" }),
      2: result({ sourceStatus: "not_found", inserted: 0, unchanged: 0 }),
      3: result({ sourceStatus: "invalid_response", inserted: 0 }),
      4: result({ status: "calendar_pending", inserted: 0 }),
      5: result({}),
    };
    ingest.syncCompanyPrices.mockImplementation(async (_ctx: unknown, id: number) => byId[id]);
    const stats = await prices.run(fakeRun());
    expect(jobs.markSynced).toHaveBeenCalledTimes(1);
    expect(jobs.markSynced).toHaveBeenCalledWith({}, "prices", 5);
    expect(jobs.markFailed).toHaveBeenCalledTimes(4);
    expect(jobs.markFailed.mock.calls.map((c) => c[2]).sort()).toEqual([1, 2, 3, 4]);
    for (const c of jobs.markFailed.mock.calls) {
      expect(c[3]).toMatchObject({ code: "price_incomplete" });
    }
    expect(stats).toMatchObject({ items: 5, failed: 4, synced: 1 });
  });
});
