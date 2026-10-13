import { randomUUID } from "node:crypto";
import { closeDb, createDb, type Db, sql } from "@ma/db";
import {
  type DailyBar,
  desiredWindow,
  istToday,
  PRICE_PARSER_VERSION,
  PriceValidationError,
  type YahooHistory,
} from "@ma/ingest";
import { DeferredError } from "@ma/jobs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WorkerContext } from "../context.js";
import type { UnitRun } from "../registry.js";
import { priceHandlers } from "./prices.js";

const url = process.env.DATABASE_URL_TEST;
// Held by the ingest manifest test while it rewrites every series in the database.
const PRICE_TEST_LOCK = 74_201;

function bar(date: string, close: number): DailyBar {
  return { date, open: close, high: close + 1, low: close - 1, close, adjClose: close, volume: 1 };
}

describe.skipIf(!url)("price handlers against the real pipeline (DATABASE_URL_TEST)", () => {
  let db: Db;
  let lock: Awaited<ReturnType<Db["$client"]["reserve"]>>;
  const tag = `H${randomUUID().slice(0, 8).toUpperCase()}`;
  const symbol = `${tag}.NS`;
  const firstWeek = ["1992-01-01", "1992-01-02", "1992-01-03", "1992-01-06", "1992-01-07"];
  const rest = ["1992-01-08", "1992-01-09", "1992-01-10", "1992-01-13", "1992-01-14"];
  // Sessions just outside the series, so only the missing `rest` week is a calendar hole.
  const fences = ["1991-12-31", "1992-01-15"];
  const ids = { company: 0, series: 0, recent: 0, recentSeries: 0, bare: 0 };
  let yahoo: (symbol: string, w: { from: string; toExclusive: string }) => YahooHistory | null;
  let yahooCalls = 0;

  const history = (sym: string, bars: DailyBar[]): YahooHistory => ({
    meta: {
      symbol: sym,
      currency: "INR",
      exchange: "NSI",
      instrumentType: "EQUITY",
      timezone: "IST",
      gmtOffsetSeconds: 19_800,
      firstTradeDate: null,
    },
    bars,
    events: [],
    rejected: [],
  });
  const serve =
    (sym: string, dates: string[]) => (s: string, w: { from: string; toExclusive: string }) =>
      s === sym
        ? history(
            sym,
            dates.filter((d) => d >= w.from && d < w.toExclusive).map((d) => bar(d, 100)),
          )
        : null;

  const ctx = () =>
    ({
      db,
      redis: { pttl: async () => -2, set: async () => "OK" },
      yahoo: {
        dailyBarsBetween: async (s: string, w: { from: string; toExclusive: string }) => {
          yahooCalls++;
          return yahoo(s, w);
        },
      },
      nse: {},
      logger: { warn: () => undefined, info: () => undefined, error: () => undefined },
    }) as unknown as WorkerContext;

  function run<T extends "prices.window" | "prices.rebuild" | "prices.sync">(
    type: T,
    payload: object,
  ): UnitRun<T> {
    return {
      ctx: ctx(),
      type,
      payload: payload as UnitRun<T>["payload"],
      attempt: 1,
      campaignId: null,
      deadline: Date.now() + 60_000,
      signal: new AbortController().signal,
      fence: undefined as unknown as UnitRun["fence"],
      expired: () => false,
    };
  }

  const windowUnit = (from: string, toExclusive: string) => ({
    seriesId: ids.series,
    symbol,
    from,
    toExclusive,
    generation: 1,
    parserVersion: PRICE_PARSER_VERSION,
  });

  async function stored(): Promise<number> {
    const [r] = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from prices_daily where company_id = ${ids.company}`,
    );
    return Number(r?.n);
  }

  async function seriesState(id: number) {
    const [s] = await db.execute<{ g: number; q: string; detail: string | null }>(sql`
      select adjustment_generation as g, quality_status as q, detail
      from price_series_state where id = ${id}`);
    return s;
  }

  async function syncedAt(companyId: number): Promise<string | null | undefined> {
    const [r] = await db.execute<{ synced_at: string | null }>(sql`
      select synced_at::text from company_sync where company_id = ${companyId} and job = 'prices'`);
    return r?.synced_at;
  }

  async function company(sym: string, yahooSymbol: string | null, from: string, to: string) {
    const [c] = await db.execute<{ id: number }>(sql`
      insert into companies (name, normalized_name, nse_symbol, yahoo_symbol, listing_status)
      values (${sym}, ${sym}, ${sym}, ${yahooSymbol}, 'active') returning id`);
    const id = Number(c?.id);
    const [s] = await db.execute<{ id: number }>(sql`
      insert into price_series_state (company_id, desired_from, desired_to, adjustment_generation,
        exception_reason, quality_status)
      values (${id}, ${from}, ${to}, 1, ${yahooSymbol ? null : "no_yahoo_symbol"},
        ${yahooSymbol ? "pending" : "exception"})
      returning id`);
    if (yahooSymbol)
      await db.execute(sql`
        insert into market_symbols (company_id, provider, symbol, valid_from)
        values (${id}, 'yahoo', ${yahooSymbol}, ${from})`);
    return { id, series: Number(s?.id) };
  }

  beforeAll(async () => {
    db = createDb(url ?? "", 2);
    lock = await db.$client.reserve();
    await lock`select pg_advisory_lock(${PRICE_TEST_LOCK})`;
    const main = await company(tag, symbol, "1992-01-01", "1992-01-14");
    ids.company = main.id;
    ids.series = main.series;
    const desired = await desiredWindow(db);
    const recent = await company(`${tag}R`, `${tag}R.NS`, desired.from, desired.to);
    ids.recent = recent.id;
    ids.recentSeries = recent.series;
    ids.bare = (await company(`${tag}B`, null, desired.from, desired.to)).id;
    for (const d of [...fences, ...firstWeek])
      await db.execute(sql`
        insert into trading_sessions (exchange, date, source) values ('NSE', ${d}, ${tag})
        on conflict do nothing`);
  });

  afterAll(async () => {
    const companies = [ids.company, ids.recent, ids.bare];
    for (const id of companies) {
      await db.execute(sql`
        delete from price_gaps where series_id in
          (select id from price_series_state where company_id = ${id})`);
      await db.execute(sql`delete from price_series_state where company_id = ${id}`);
      await db.execute(sql`delete from prices_daily where company_id = ${id}`);
      await db.execute(sql`delete from company_sync where company_id = ${id}`);
      await db.execute(sql`delete from market_symbols where company_id = ${id}`);
      await db.execute(sql`delete from companies where id = ${id}`);
    }
    await db.execute(sql`delete from trading_sessions where source = ${tag}`);
    await lock`select pg_advisory_unlock(${PRICE_TEST_LOCK})`;
    lock.release();
    await closeDb(db);
  });

  it("defers an equity window until the calendar spans it, without fetching or writing", async () => {
    yahoo = serve(symbol, [...firstWeek, ...rest]);
    yahooCalls = 0;
    const unit = windowUnit("1992-01-08", "1992-01-15");
    const early = priceHandlers["prices.window"](run("prices.window", unit));
    await expect(early).rejects.toBeInstanceOf(DeferredError);
    await expect(early).rejects.toThrow(/8-day hole/);
    expect(yahooCalls).toBe(0);
    expect(await stored()).toBe(0);

    for (const d of rest)
      await db.execute(sql`
        insert into trading_sessions (exchange, date, source) values ('NSE', ${d}, ${tag})
        on conflict do nothing`);
    const later = await priceHandlers["prices.window"](run("prices.window", unit));
    expect(later.metrics).toMatchObject({ written: 1, inserted: rest.length });
  });

  it("retries a window whose Yahoo response is null", async () => {
    yahoo = () => null;
    const r = priceHandlers["prices.window"](
      run("prices.window", windowUnit("1992-01-01", "1992-01-08")),
    );
    await expect(r).rejects.toMatchObject({ code: "price_incomplete" });
    expect(await stored()).toBe(rest.length);
    expect((await seriesState(ids.series))?.detail).toMatch(/5 expected sessions missing/);
  });

  it("retries a window whose Yahoo response fails validation", async () => {
    yahoo = () => {
      throw new PriceValidationError("yahoo", "instrument mismatch: currency", { symbol });
    };
    const r = priceHandlers["prices.window"](
      run("prices.window", windowUnit("1992-01-01", "1992-01-08")),
    );
    await expect(r).rejects.toMatchObject({
      code: "price_incomplete",
      details: { sourceStatus: "invalid_response" },
    });
    const gaps = await db.execute<{ reason: string }>(sql`
      select reason from price_gaps where series_id = ${ids.series} and status = 'open'`);
    expect(gaps.map((g) => g.reason)).toEqual(["invalid_bars"]);
  });

  it("still retries a null response when the window's rows are already stored", async () => {
    yahoo = serve(symbol, firstWeek);
    const ok = await priceHandlers["prices.window"](
      run("prices.window", windowUnit("1992-01-01", "1992-01-08")),
    );
    expect(ok.metrics).toMatchObject({ written: 1, inserted: firstWeek.length });
    yahoo = () => null;
    await expect(
      priceHandlers["prices.window"](run("prices.window", windowUnit("1992-01-01", "1992-01-08"))),
    ).rejects.toMatchObject({ code: "price_incomplete", details: { sourceStatus: "not_found" } });
  });

  it("refuses and retries an empty rebuild, keeping the stored generation", async () => {
    yahoo = () => null;
    const before = await stored();
    await expect(
      priceHandlers["prices.rebuild"](
        run("prices.rebuild", {
          seriesId: ids.series,
          symbol,
          generation: 2,
          parserVersion: PRICE_PARSER_VERSION,
        }),
      ),
    ).rejects.toMatchObject({
      code: "price_incomplete",
      details: { status: "rebuild_incomplete" },
    });
    expect(await stored()).toBe(before);
    expect(await seriesState(ids.series)).toMatchObject({
      g: 1,
      q: "rebuild_required",
      detail: expect.stringMatching(/refused/),
    });
  });

  it("prices.sync marks a company synced only when its window is complete through the latest session", async () => {
    const sessions = await db.execute<{ d: string }>(sql`
      select date::text as d from trading_sessions
      where exchange = 'NSE' and date >= ${addDaysIso(istToday(), -40)} order by date`);
    const recent = `${tag}R.NS`;

    yahoo = () => null;
    await expect(
      priceHandlers["prices.sync"](run("prices.sync", { companyId: ids.recent })),
    ).rejects.toMatchObject({ code: "price_incomplete" });
    expect(await syncedAt(ids.recent)).toBeNull();

    yahoo = serve(
      recent,
      sessions.map((s) => s.d),
    );
    const ok = await priceHandlers["prices.sync"](run("prices.sync", { companyId: ids.recent }));
    expect(ok.metrics).toMatchObject({ written: 1, latestCovered: 1 });
    expect(await syncedAt(ids.recent)).not.toBeNull();
    expect((await seriesState(ids.recentSeries))?.detail).toBeNull();

    const bare = await priceHandlers["prices.sync"](run("prices.sync", { companyId: ids.bare }));
    expect(bare.metrics).toMatchObject({ missing_series: 1, bars: 0 });
    expect(await syncedAt(ids.bare)).toBeUndefined();
  });

  it("records a contested symbol as a durable series exception instead of retrying", async () => {
    const recent = `${tag}R.NS`;
    await db.execute(sql`
      insert into market_symbols (company_id, provider, symbol, valid_from)
      values (${ids.bare}, 'yahoo', ${recent}, '2000-01-01')`);
    yahooCalls = 0;
    const today = istToday();
    const done = await priceHandlers["prices.window"](
      run("prices.window", {
        seriesId: ids.recentSeries,
        symbol: recent,
        from: addDaysIso(today, -7),
        toExclusive: addDaysIso(today, 1),
        generation: 1,
        parserVersion: PRICE_PARSER_VERSION,
      }),
    );
    expect(done.metrics).toMatchObject({ written: 1, source_identity_mismatch: 1 });
    expect(yahooCalls).toBe(0);
    const [s] = await db.execute<{ q: string; reason: string | null }>(sql`
      select quality_status as q, exception_reason as reason
      from price_series_state where id = ${ids.recentSeries}`);
    expect(s).toEqual({ q: "exception", reason: "identity_mismatch" });

    const skipped = await priceHandlers["prices.sync"](
      run("prices.sync", { companyId: ids.recent }),
    );
    expect(skipped.metrics).toMatchObject({ missing_series: 1, bars: 0 });
    expect(yahooCalls).toBe(0);
  });
});

function addDaysIso(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}
