import { randomUUID } from "node:crypto";
import { closeDb, createDb, type Db, sql } from "@ma/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IngestContext } from "../context.js";
import { MARKET_INDICES } from "../data/market-indices.js";
import { type DailyBar, istToday, type YahooEvent, type YahooHistory } from "../sources/yahoo.js";
import {
  actionHash,
  backfillWindows,
  buildBackfillManifest,
  changedSql,
  desiredWindow,
  gapBackoffMs,
  mergeFallback,
  missingRanges,
  needsRebuild,
  PRICE_HISTORY_YEARS,
  rebuildSeries,
  syncPriceWindow,
} from "./prices.js";

const PRICE_TEST_LOCK = 74_201;

const DAY_MS = 86_400_000;

function bar(date: string, close: number): DailyBar {
  return {
    date,
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    adjClose: close,
    volume: 100,
  };
}

function dividend(exDate: string, cash: number): YahooEvent {
  return {
    type: "dividend",
    exDate,
    eventKey: `dividend:${exDate}`,
    numerator: null,
    denominator: null,
    cashAmount: cash,
    currency: "INR",
  };
}

describe("backfillWindows", () => {
  it("covers five contiguous years ending after today", () => {
    const w = backfillWindows("2021-10-12", "2026-10-13");
    expect(w).toHaveLength(PRICE_HISTORY_YEARS);
    expect(w[0]).toEqual({ from: "2021-10-12", toExclusive: "2022-10-12" });
    for (let i = 1; i < w.length; i++) expect(w[i]?.from).toBe(w[i - 1]?.toExclusive);
    expect(w.at(-1)?.toExclusive).toBe("2026-10-14");
  });

  it("sizes the backfill manifest at (series) x 5 annual units", () => {
    const companies = 528;
    expect((companies + MARKET_INDICES.length) * PRICE_HISTORY_YEARS).toBe(2_675);
  });
});

describe("missingRanges", () => {
  it("coalesces consecutive missing sessions by reason", () => {
    const sessions = [
      { date: "2024-01-01", missing: true },
      { date: "2024-01-02", missing: true },
      { date: "2024-01-03", missing: false },
      { date: "2024-01-04", missing: true },
      { date: "2024-01-05", missing: true },
    ];
    const reason = (d: string) => (d === "2024-01-05" ? "invalid_bars" : "missing_source_data");
    expect(missingRanges(sessions, reason)).toEqual([
      { from: "2024-01-01", to: "2024-01-02", sessions: 2, reason: "missing_source_data" },
      { from: "2024-01-04", to: "2024-01-04", sessions: 1, reason: "missing_source_data" },
      { from: "2024-01-05", to: "2024-01-05", sessions: 1, reason: "invalid_bars" },
    ]);
    expect(missingRanges([], reason)).toEqual([]);
  });
});

describe("gapBackoffMs", () => {
  it("doubles from one day and caps at thirty days", () => {
    expect(gapBackoffMs(0)).toBe(DAY_MS);
    expect(gapBackoffMs(1)).toBe(DAY_MS);
    expect(gapBackoffMs(3)).toBe(4 * DAY_MS);
    expect(gapBackoffMs(20)).toBe(30 * DAY_MS);
  });
});

describe("needsRebuild", () => {
  const added = [dividend("2026-10-01", 5)];
  it("rebuilds on corrections and on actions newer than the stored basis", () => {
    expect(needsRebuild({ added: [], corrected: added }, null)).toBe(true);
    expect(needsRebuild({ added, corrected: [] }, "2026-09-30")).toBe(true);
    expect(needsRebuild({ added, corrected: [] }, "2026-10-02")).toBe(false);
    expect(needsRebuild({ added, corrected: [] }, null)).toBe(false);
  });

  it("hashes actions independent of order", () => {
    const a = { eventKey: "a", splitNumerator: null, splitDenominator: null, cashAmount: 1 };
    const b = { eventKey: "b", splitNumerator: 2, splitDenominator: 1, cashAmount: null };
    expect(actionHash([a, b])).toBe(actionHash([b, a]));
    expect(actionHash([a])).not.toBe(actionHash([{ ...a, cashAmount: 2 }]));
  });
});

describe("mergeFallback", () => {
  const primary = [bar("2024-01-01", 100), bar("2024-01-03", 102)].map((b) => ({
    ...b,
    source: "yahoo",
  }));

  it("fills missing sessions when overlapping closes agree", () => {
    const r = mergeFallback(primary, [bar("2024-01-02", 101), bar("2024-01-03", 102.01)], "nse");
    expect(r).toMatchObject({ added: 1, mismatches: 0 });
    expect(r.bars.map((b) => `${b.date}:${b.source}`)).toEqual([
      "2024-01-01:yahoo",
      "2024-01-02:nse",
      "2024-01-03:yahoo",
    ]);
  });

  it("adds nothing when any overlapping close disagrees", () => {
    const r = mergeFallback(primary, [bar("2024-01-02", 101), bar("2024-01-03", 110)], "nse");
    expect(r).toMatchObject({ added: 0, mismatches: 1 });
    expect(r.bars).toBe(primary);
  });

  it("adds nothing when no fallback session overlaps a primary close", () => {
    const r = mergeFallback(primary, [bar("2024-01-02", 101), bar("2024-01-04", 103)], "nse");
    expect(r).toMatchObject({ added: 0, agreements: 0, mismatches: 0 });
    expect(r.bars).toBe(primary);
    expect(mergeFallback([], [bar("2024-01-02", 101)], "nse").added).toBe(0);
  });

  it("corroborates against stored closes and only adds bars inside the window", () => {
    const r = mergeFallback(
      [],
      [bar("2023-12-29", 99), bar("2024-01-02", 101), bar("2024-01-10", 105)],
      "nse",
      {
        reference: new Map([["2023-12-29", 99.01]]),
        window: { from: "2024-01-01", toExclusive: "2024-01-09" },
      },
    );
    expect(r).toMatchObject({ added: 1, agreements: 1, mismatches: 0 });
    expect(r.bars.map((b) => b.date)).toEqual(["2024-01-02"]);
  });
});

describe("changedSql", () => {
  it("compares floats with a relative tolerance and the rest exactly", () => {
    const s = changedSql("prices_daily", ["volume"], ["close"]);
    expect(s).toContain('("prices_daily".volume) is distinct from (excluded.volume)');
    expect(s).toContain('abs("prices_daily".close - excluded.close) > 0.00001');
  });
});

const url = process.env.DATABASE_URL_TEST;

describe.skipIf(!url)("price series writes (DATABASE_URL_TEST)", () => {
  let db: Db;
  let companyId: number;
  let seriesId: number;
  const tag = `T${randomUUID().slice(0, 8).toUpperCase()}`;
  const symbol = `${tag}.NS`;
  const sessions = [
    "1990-01-01",
    "1990-01-02",
    "1990-01-03",
    "1990-01-04",
    "1990-01-05",
    "1990-01-08",
  ];
  // Sessions just outside the series so the calendar around the window has no multi-day hole.
  const fences = ["1989-12-29", "1990-01-09"];
  const window = { from: "1990-01-01", toExclusive: "1990-01-09" };
  let history: YahooHistory;

  const ctx = () =>
    ({
      db,
      redis: { pttl: async () => -2, set: async () => "OK" },
      yahoo: { dailyBarsBetween: async () => history },
      nse: {},
      logger: { warn: () => undefined, info: () => undefined },
    }) as unknown as IngestContext;

  const historyOf = (bars: DailyBar[], events: YahooEvent[] = []): YahooHistory => ({
    meta: {
      symbol,
      currency: "INR",
      exchange: "NSI",
      instrumentType: "EQUITY",
      timezone: "IST",
      gmtOffsetSeconds: 19_800,
      firstTradeDate: null,
    },
    bars,
    events,
    rejected: [],
  });

  async function rows() {
    return db.execute<{ date: string; g: number; adj: number; final: boolean }>(sql`
      select date::text, adjustment_generation as g, adj_close as adj, is_final as final
      from prices_daily where company_id = ${companyId} order by date`);
  }

  async function state() {
    const [s] = await db.execute<{ g: number; q: string; verified_through: string | null }>(sql`
      select adjustment_generation as g, quality_status as q, verified_through::text
      from price_series_state where id = ${seriesId}`);
    return s;
  }

  beforeAll(async () => {
    db = createDb(url ?? "", 2);
    const [c] = await db.execute<{ id: number }>(sql`
      insert into companies (name, normalized_name, nse_symbol, yahoo_symbol, listing_status)
      values (${tag}, ${tag}, ${tag}, ${symbol}, 'active') returning id`);
    companyId = Number(c?.id);
    const [s] = await db.execute<{ id: number }>(sql`
      insert into price_series_state (company_id, desired_from, desired_to)
      values (${companyId}, '1990-01-01', '1990-01-08') returning id`);
    seriesId = Number(s?.id);
    await db.execute(sql`
      insert into market_symbols (company_id, provider, symbol, valid_from)
      values (${companyId}, 'yahoo', ${symbol}, '1990-01-01')`);
    for (const d of [...sessions, ...fences])
      await db.execute(sql`
        insert into trading_sessions (exchange, date, source) values ('NSE', ${d}, ${tag})
        on conflict do nothing`);
  });

  afterAll(async () => {
    await db.execute(sql`delete from price_gaps where series_id = ${seriesId}`);
    await db.execute(sql`delete from price_series_state where id = ${seriesId}`);
    await db.execute(sql`delete from prices_daily where company_id = ${companyId}`);
    await db.execute(sql`delete from corporate_actions where company_id = ${companyId}`);
    await db.execute(sql`delete from market_symbols where company_id = ${companyId}`);
    await db.execute(sql`delete from companies where id = ${companyId}`);
    await db.execute(sql`delete from trading_sessions where source = ${tag}`);
    await closeDb(db);
  });

  it("writes a window, records the missing session as a gap and replays without churn", async () => {
    const bars = sessions.filter((d) => d !== "1990-01-04").map((d, i) => bar(d, 100 + i));
    history = historyOf(bars);
    const first = await syncPriceWindow(
      ctx(),
      { seriesId, symbol, ...window, generation: 1 },
      "backfill",
    );
    expect(first).toMatchObject({
      status: "incomplete",
      inserted: 5,
      gaps: 1,
      missingSessions: 1,
      windowMissing: 1,
      latestCovered: true,
    });
    expect(first.detail).toMatch(/^1 expected sessions missing in window/);
    const gaps = await db.execute<{ from_date: string; reason: string; checks: number }>(sql`
      select from_date::text, reason, checks from price_gaps where series_id = ${seriesId}`);
    expect(gaps).toEqual([{ from_date: "1990-01-04", reason: "missing_source_data", checks: 1 }]);
    expect(await state()).toMatchObject({ g: 1, q: "partial", verified_through: "1990-01-03" });
    expect((await rows()).every((r) => r.final && r.g === 1)).toBe(true);

    history = historyOf(bars.map((b) => ({ ...b, adjClose: (b.adjClose as number) * (1 + 1e-7) })));
    const replay = await syncPriceWindow(
      ctx(),
      { seriesId, symbol, ...window, generation: 1 },
      "backfill",
    );
    expect(replay).toMatchObject({ status: "incomplete", inserted: 0, updated: 0, unchanged: 5 });
  });

  it("completes the series once the gap is filled", async () => {
    history = historyOf(sessions.map((d, i) => bar(d, 100 + i)));
    const r = await syncPriceWindow(
      ctx(),
      { seriesId, symbol, ...window, generation: 1 },
      "repair",
    );
    expect(r).toMatchObject({
      status: "written",
      inserted: 1,
      gaps: 0,
      windowMissing: 0,
      quality: "complete",
      detail: null,
    });
    expect(await state()).toMatchObject({ q: "complete", verified_through: "1990-01-08" });
  });

  it("refuses to write under a symbol the series does not own", async () => {
    const r = await syncPriceWindow(
      ctx(),
      { seriesId, symbol: "OTHER.NS", ...window, generation: 1 },
      "backfill",
    );
    expect(r.status).toBe("identity_mismatch");
    expect(r.inserted).toBe(0);
  });

  it("flags a new action as rebuild_required without rescaling, then rebuilds atomically", async () => {
    const before = await rows();
    history = historyOf(
      sessions.map((d, i) => bar(d, 90 + i)),
      [dividend(istToday(), 3)],
    );
    const daily = await syncPriceWindow(
      ctx(),
      { seriesId, symbol, ...window, generation: 1 },
      "daily",
    );
    expect(daily.status).toBe("rebuild_required");
    expect(await rows()).toEqual(before);
    expect((await state())?.q).toBe("rebuild_required");

    const stale = await rebuildSeries(ctx(), { seriesId, symbol, generation: 3 });
    expect(stale.status).toBe("stale_generation");
    expect(await rows()).toEqual(before);

    history = historyOf(
      sessions.slice(0, 3).map((d, i) => bar(d, 90 + i)),
      [dividend(istToday(), 3)],
    );
    const partial = await rebuildSeries(ctx(), { seriesId, symbol, generation: 2 });
    expect(partial).toMatchObject({
      status: "rebuild_incomplete",
      inserted: 0,
      updated: 0,
      missingSessions: 3,
      quality: "rebuild_required",
    });
    expect(partial.detail).toMatch(
      /refused: source lacks 3 expected sessions \(1990-01-04\.\.1990-01-08\)/,
    );
    expect(await rows()).toEqual(before);
    expect(await state()).toMatchObject({ g: 1, q: "rebuild_required" });

    history = historyOf(
      sessions.map((d, i) => bar(d, 90 + i)),
      [dividend(istToday(), 3)],
    );
    const rebuilt = await rebuildSeries(ctx(), { seriesId, symbol, generation: 2 });
    expect(rebuilt).toMatchObject({ status: "written", updated: 6 });
    const after = await rows();
    expect(after.map((r) => [r.g, r.adj])).toEqual(sessions.map((_, i) => [2, 90 + i]));
    expect(await state()).toMatchObject({ g: 2, q: "complete" });

    const late = await syncPriceWindow(
      ctx(),
      { seriesId, symbol, ...window, generation: 1 },
      "backfill",
    );
    expect(late.status).toBe("stale_generation");
  });

  it("ends the desired window at the latest session before today", async () => {
    expect((await desiredWindow(db, "1990-01-07")).to).toBe("1990-01-05");
    expect((await desiredWindow(db, "1990-01-08")).to).toBe("1990-01-05");
    expect((await desiredWindow(db, "1990-01-09")).to).toBe("1990-01-08");
    expect((await desiredWindow(db, "1990-01-09")).from).toBe("1985-01-08");
  });
});

describe.skipIf(!url)("price coverage manifest (DATABASE_URL_TEST)", () => {
  let db: Db;
  const tag = `M${randomUUID().slice(0, 8).toUpperCase()}`;
  const ids: Record<"listed" | "unlisted", number> = { listed: 0, unlisted: 0 };
  let manifestId = 0;
  let lock: Awaited<ReturnType<Db["$client"]["reserve"]>>;

  beforeAll(async () => {
    db = createDb(url ?? "", 2);
    lock = await db.$client.reserve();
    // The manifest rewrites every series in the database; the worker price handler test waits.
    await lock`select pg_advisory_lock(${PRICE_TEST_LOCK})`;
    for (const [k, yahoo] of [
      ["listed", `${tag}.NS`],
      ["unlisted", null],
    ] as const) {
      const [c] = await db.execute<{ id: number }>(sql`
        insert into companies (name, normalized_name, nse_symbol, yahoo_symbol, listing_status)
        values (${`${tag}${k}`}, ${`${tag}${k}`}, ${`${tag}${k}`.toUpperCase()}, ${yahoo}, 'active')
        returning id`);
      ids[k] = Number(c?.id);
    }
  });

  afterAll(async () => {
    await db.execute(sql`delete from price_manifests where id = ${manifestId}`);
    for (const id of Object.values(ids)) {
      await db.execute(sql`delete from price_series_state where company_id = ${id}`);
      await db.execute(sql`delete from market_symbols where company_id = ${id}`);
      await db.execute(sql`delete from companies where id = ${id}`);
    }
    await lock`select pg_advisory_unlock(${PRICE_TEST_LOCK})`;
    lock.release();
    await closeDb(db);
  });

  it("gives every company a series row and freezes a manifest that includes exceptions", async () => {
    const ctx = {
      db,
      nse: {
        equityListings: async () => {
          throw new Error("offline");
        },
      },
      logger: { warn: () => undefined, info: () => undefined },
    } as unknown as IngestContext;
    const m = await buildBackfillManifest(ctx);
    manifestId = m.manifestId;
    expect(m.manifestId).toBeGreaterThan(0);
    const [{ n } = { n: -1 }] = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from price_manifest_companies where manifest_id = ${m.manifestId}`,
    );
    expect(m.companies).toBe(Number(n));
    expect(m.companies).toBeGreaterThanOrEqual(2);

    const states = await db.execute<{ company_id: number; reason: string | null; q: string }>(sql`
      select company_id, exception_reason as reason, quality_status as q from price_series_state
      where company_id in (${ids.listed}, ${ids.unlisted}) order by company_id`);
    expect(states).toEqual([
      { company_id: ids.listed, reason: null, q: "pending" },
      { company_id: ids.unlisted, reason: "no_yahoo_symbol", q: "exception" },
    ]);

    const listedSeries = await db.execute<{ id: number }>(
      sql`select id from price_series_state where company_id = ${ids.listed}`,
    );
    const unlistedSeries = await db.execute<{ id: number }>(
      sql`select id from price_series_state where company_id = ${ids.unlisted}`,
    );
    expect(m.units.filter((u) => u.seriesId === listedSeries[0]?.id)).toHaveLength(
      PRICE_HISTORY_YEARS,
    );
    expect(m.units.some((u) => u.seriesId === unlistedSeries[0]?.id)).toBe(false);

    const frozen = await db.execute<{
      company_id: number;
      units: number;
      reason: string | null;
    }>(sql`
      select company_id, units, exception_reason as reason from price_manifest_companies
      where manifest_id = ${m.manifestId} and company_id in (${ids.listed}, ${ids.unlisted})
      order by company_id`);
    expect(frozen).toEqual([
      { company_id: ids.listed, units: PRICE_HISTORY_YEARS, reason: null },
      { company_id: ids.unlisted, units: 0, reason: "no_yahoo_symbol" },
    ]);
    const [header] = await db.execute<{ companies: number; units: number; kind: string }>(sql`
      select companies, units, kind from price_manifests where id = ${m.manifestId}`);
    expect(header).toEqual({ companies: Number(n), units: m.units.length, kind: "backfill" });
  });
});
