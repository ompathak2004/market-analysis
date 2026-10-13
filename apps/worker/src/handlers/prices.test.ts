import { AppError } from "@ma/core";
import type { PriceWindowResult } from "@ma/ingest";
import { DeferredError, isRetryable } from "@ma/jobs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UnitRun } from "../registry.js";

const m = vi.hoisted(() => ({
  window: vi.fn(),
  rebuild: vi.fn(),
  markSynced: vi.fn(),
  manifest: vi.fn(),
}));

vi.mock("@ma/ingest", async (orig) => ({
  ...(await orig<typeof import("@ma/ingest")>()),
  loadSeries: async () => ({ kind: "equity", ownerId: 7 }),
  dailyWindow: async () => ({ from: "2026-10-01", toExclusive: "2026-10-14" }),
  syncPriceWindow: m.window,
  rebuildSeries: m.rebuild,
  buildBackfillManifest: m.manifest,
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
    windowExpected: 1,
    latestCovered: true,
    source: "yahoo",
    sourceStatus: "ok",
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

  it("retries a source that answered nothing or answered invalid bars, even with rows stored", () => {
    for (const sourceStatus of ["not_found", "invalid_response"] as const)
      expect(() => requireComplete(result({ sourceStatus, windowExpected: 5 }))).toThrow(
        expect.objectContaining({
          code: "price_incomplete",
          details: expect.objectContaining({ sourceStatus }),
        }),
      );
    const holiday = result({ sourceStatus: "not_found", windowExpected: 0 });
    expect(requireComplete(holiday)).toBe(holiday);
  });

  it("keeps an identity mismatch as a series exception instead of retrying it", () => {
    const r = result({ sourceStatus: "identity_mismatch", quality: "exception" });
    expect(requireComplete(r)).toBe(r);
  });

  it("defers a window the calendar does not span yet, without spending an attempt", () => {
    const now = Date.parse("2026-10-13T10:00:00Z");
    let err: unknown;
    try {
      requireComplete(result({ status: "calendar_pending", detail: "calendar ends" }), now);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DeferredError);
    expect((err as DeferredError).resumeAt.getTime()).toBe(now + 3 * 60_000);
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

  it("queues calendar windows ahead of other indices, and both ahead of equity backfill", async () => {
    const unit = (seriesId: number) => ({ seriesId, symbol: `S${seriesId}`, from: "2025-01-01" });
    m.manifest.mockResolvedValueOnce({
      manifestId: 1,
      companies: 2,
      series: 4,
      exceptions: [],
      calendarSeriesId: 10,
      indexSeriesIds: [10, 11],
      units: [unit(20), unit(11), unit(21), unit(10)],
    });
    const out = await priceHandlers["prices.backfill"](
      run({}) as unknown as UnitRun<"prices.backfill">,
    );
    expect(out.children?.map((c) => [c.payload.seriesId, c.priority])).toEqual([
      [20, -1],
      [11, 2],
      [21, -1],
      [10, 3],
    ]);
  });
});
