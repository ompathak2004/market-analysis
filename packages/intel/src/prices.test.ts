import { describe, expect, it } from "vitest";
import {
  coverageCounts,
  expectedSession,
  istToday,
  type PriceCloses,
  seriesReturn,
  totalReturn,
} from "./prices.js";

const SESSIONS = ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09"];

function closes(
  bars: Record<number, Array<[string, number]>>,
  quality: Record<number, string> = {},
): PriceCloses {
  const out: PriceCloses = {
    series: new Map(),
    meta: new Map(),
    sessions: SESSIONS,
    today: "2026-10-13",
  };
  for (const [id, rows] of Object.entries(bars)) {
    out.series.set(Number(id), new Map(rows));
    out.meta.set(Number(id), {
      generation: 1,
      quality: quality[Number(id)] ?? "complete",
      finalThrough: rows.at(-1)?.[0] ?? null,
    });
  }
  return out;
}

describe("expectedSession", () => {
  it("finds the latest session on or before a boundary", () => {
    expect(expectedSession(SESSIONS, "2026-10-07")).toBe(2);
    expect(expectedSession(SESSIONS, "2026-10-11")).toBe(4);
    expect(expectedSession(SESSIONS, "2026-10-01")).toBe(-1);
  });
});

describe("seriesReturn", () => {
  const full = SESSIONS.map((d, i): [string, number] => [d, 100 + i * 10]);

  it("returns adjusted-close returns between expected sessions", () => {
    const c = closes({ 1: full });
    expect(totalReturn(c, 1, "2026-10-05", "2026-10-11")).toBeCloseTo(0.4);
    expect(totalReturn(c, 1, "2026-10-06", "2026-10-08")).toBeCloseTo(20 / 110);
  });

  it("tolerates one missing session at an endpoint but not a stale close", () => {
    const oneGap = full.filter(([d]) => d !== "2026-10-09");
    expect(totalReturn(closes({ 1: oneGap }), 1, "2026-10-05", "2026-10-09")).toBeCloseTo(0.3);
    const stale = full.filter(([d]) => d < "2026-10-08");
    expect(seriesReturn(closes({ 1: stale }), 1, "2026-10-05", "2026-10-09")).toEqual({
      ok: false,
      reason: "stale_end",
    });
    const lateStart = full.filter(([d]) => d > "2026-10-06");
    expect(seriesReturn(closes({ 1: lateStart }), 1, "2026-10-05", "2026-10-09")).toEqual({
      ok: false,
      reason: "stale_start",
    });
  });

  it("explains missing coverage instead of returning zero", () => {
    const c = closes({ 1: full, 2: full, 3: [] }, { 2: "rebuild_required" });
    expect(seriesReturn(c, 9, "2026-10-05", "2026-10-09")).toEqual({
      ok: false,
      reason: "no_series",
    });
    expect(seriesReturn(c, 2, "2026-10-05", "2026-10-09")).toEqual({
      ok: false,
      reason: "rebuild_required",
    });
    expect(seriesReturn(c, 3, "2026-10-05", "2026-10-09")).toEqual({
      ok: false,
      reason: "no_final_bars",
    });
    expect(seriesReturn({ ...c, sessions: [] }, 1, "2026-10-05", "2026-10-09")).toEqual({
      ok: false,
      reason: "no_calendar",
    });
    expect(coverageCounts(["no_series", "stale_end", "no_series"])).toEqual({
      no_series: 2,
      stale_end: 1,
    });
  });
});

describe("istToday", () => {
  it("rolls over at IST midnight", () => {
    expect(istToday(Date.parse("2026-10-12T18:29:00Z"))).toBe("2026-10-12");
    expect(istToday(Date.parse("2026-10-12T18:31:00Z"))).toBe("2026-10-13");
  });
});
