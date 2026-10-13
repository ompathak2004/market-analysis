import { AppError } from "@ma/core";
import type { PriceWindowResult } from "@ma/ingest";
import { isRetryable } from "@ma/jobs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UnitRun } from "../registry.js";

const m = vi.hoisted(() => ({
  window: vi.fn(),
  rebuild: vi.fn(),
  markSynced: vi.fn(),
}));

vi.mock("@ma/ingest", async (orig) => ({
  ...(await orig<typeof import("@ma/ingest")>()),
  loadSeries: async () => ({ kind: "equity", ownerId: 7 }),
  dailyWindow: async () => ({ from: "2026-10-01", toExclusive: "2026-10-14" }),
  syncPriceWindow: m.window,
  rebuildSeries: m.rebuild,
}));

vi.mock("@ma/jobs", async (orig) => ({
  ...(await orig<typeof import("@ma/jobs")>()),
  markSynced: m.markSynced,
}));

const { priceHandlers, requireComplete } = await import("./prices.js");
const { PRICE_PARSER_VERSION } = await import("@ma/ingest");

function result(over: Partial<PriceWindowResult>): PriceWindowResult {
  return {
    status: "written",
    inserted: 0,
    updated: 0,
    unchanged: 0,
    rejected: 0,
    events: 0,
    newActions: 0,
    gaps: 0,
    missingSessions: 0,
    windowMissing: 0,
    latestCovered: true,
    source: "yahoo",
    quality: "complete",
    detail: null,
    ...over,
  };
}

function run(payload: object): UnitRun<"prices.daily"> {
  return {
    ctx: {} as UnitRun["ctx"],
    type: "prices.daily",
    payload: payload as UnitRun<"prices.daily">["payload"],
    attempt: 1,
    campaignId: null,
    deadline: Date.now() + 60_000,
    signal: new AbortController().signal,
    fence: {} as UnitRun["fence"],
    expired: () => false,
  };
}

describe("requireComplete", () => {
  it("passes written windows through and fails incomplete ones with a retryable error", () => {
    expect(requireComplete(result({})).status).toBe("written");
    for (const status of ["incomplete", "rebuild_incomplete"] as const) {
      let err: unknown;
      try {
        requireComplete(result({ status, windowMissing: 2, detail: "2 missing" }));
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe("price_incomplete");
      expect(isRetryable(err)).toBe(true);
    }
  });
});

describe("price handlers", () => {
  const daily = { seriesId: 1, symbol: "X.NS", date: "2026-10-13" };
  beforeEach(() => {
    m.window.mockReset();
    m.rebuild.mockReset();
    m.markSynced.mockReset();
  });

  it("marks the company synced only when the window is complete through the latest session", async () => {
    m.window.mockResolvedValueOnce(result({ latestCovered: false }));
    await priceHandlers["prices.daily"](run(daily));
    expect(m.markSynced).not.toHaveBeenCalled();

    m.window.mockResolvedValueOnce(result({}));
    await priceHandlers["prices.daily"](run(daily));
    expect(m.markSynced).toHaveBeenCalledTimes(1);
  });

  it("fails an incomplete daily window without marking it synced", async () => {
    m.window.mockResolvedValueOnce(result({ status: "incomplete", windowMissing: 3 }));
    await expect(priceHandlers["prices.daily"](run(daily))).rejects.toMatchObject({
      code: "price_incomplete",
    });
    expect(m.markSynced).not.toHaveBeenCalled();
  });

  it("fails incomplete backfill windows and refused rebuilds, but not repair re-checks", async () => {
    const unit = {
      seriesId: 1,
      symbol: "X.NS",
      from: "2025-01-01",
      toExclusive: "2026-01-01",
      generation: 1,
      parserVersion: PRICE_PARSER_VERSION,
    };
    m.window.mockResolvedValue(result({ status: "incomplete", windowMissing: 1 }));
    await expect(
      priceHandlers["prices.window"](run(unit) as unknown as UnitRun<"prices.window">),
    ).rejects.toMatchObject({ code: "price_incomplete" });
    const repair = await priceHandlers["prices.window"](
      run({ ...unit, mode: "repair" }) as unknown as UnitRun<"prices.window">,
    );
    expect(repair.metrics).toMatchObject({ incomplete: 1 });

    m.rebuild.mockResolvedValueOnce(result({ status: "rebuild_incomplete", missingSessions: 250 }));
    await expect(
      priceHandlers["prices.rebuild"](
        run({
          seriesId: 1,
          symbol: "X.NS",
          generation: 2,
          parserVersion: PRICE_PARSER_VERSION,
        }) as unknown as UnitRun<"prices.rebuild">,
      ),
    ).rejects.toMatchObject({ code: "price_incomplete" });
  });
});
