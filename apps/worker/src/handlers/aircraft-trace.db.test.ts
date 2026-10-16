import { randomUUID } from "node:crypto";
import { createLogger } from "@ma/core";
import { closeDb, createDb, type Db, sql } from "@ma/db";
import {
  aircraftRepairTargets,
  airportByIcao,
  collectAircraftTraces,
  deriveAircraftFlights,
  type IngestContext,
} from "@ma/ingest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.DATABASE_URL_TEST;
const NOW = new Date("2026-10-14T14:30:00Z");
const T0 = Date.parse("2026-10-14T11:10:00Z");
const VECC = airportByIcao("VECC");
const VABB = airportByIcao("VABB");

class FakeRedis {
  strings = new Map<string, string>();
  async get(k: string) {
    return this.strings.get(k) ?? null;
  }
  async set(k: string, v: string) {
    this.strings.set(k, v);
    return "OK";
  }
  async del(...keys: string[]) {
    for (const k of keys) this.strings.delete(k);
    return keys.length;
  }
}

function point(
  offset: number,
  lat: number,
  lon: number,
  alt: number | "ground",
  gs: number,
): unknown[] {
  return [offset, lat, lon, alt, gs, 270, 0, 0, null, "adsb_icao"];
}

describe.skipIf(!url)("aircraft.trace pipeline (DATABASE_URL_TEST)", () => {
  let db: Db;
  let aircraftId: number;
  const hex = `8${randomUUID().replaceAll("-", "").slice(0, 5)}`;
  const registration = `VT-${hex.slice(1, 4).toUpperCase()}`;
  const redis = new FakeRedis();
  const requests: string[] = [];
  let trace: unknown[][] = [];
  const http = {
    get: async (u: string) => {
      requests.push(u);
      const body = JSON.stringify({ icao: hex, r: registration, timestamp: T0 / 1000, trace });
      return { status: 200, text: () => body, body: new Uint8Array(), headers: new Headers() };
    },
  };
  const ctx = () =>
    ({ db, redis, http, logger: createLogger("test", "silent") }) as unknown as IngestContext;

  beforeAll(async () => {
    if (!url || !VECC || !VABB) throw new Error("test prerequisites missing");
    db = createDb(url, 2);
    const [aircraft] = await db.execute<{ id: number }>(sql`
      insert into corporate_aircraft (registration, icao_hex, tier, confidence, active, last_seen_at)
      values (${registration}, ${hex}, 'registry', 0.9, true, ${NOW.toISOString()}::timestamptz) returning id`);
    if (!aircraft) throw new Error("Test aircraft missing");
    aircraftId = aircraft.id;
    const sparse = [
      [T0 + 25 * 60_000, 22.1, 88.0, 41_000],
      [T0 + 30 * 60_000, 22.0, 87.3, 41_000],
      [T0 + 35 * 60_000, 21.9, 86.6, 41_000],
      [T0 + 70 * 60_000, 20.5, 76.5, 41_000],
      [T0 + 75 * 60_000, 20.3, 75.8, 41_000],
      [T0 + 80 * 60_000, 20.1, 75.1, 41_000],
    ];
    for (const [ts, lat, lon, alt] of sparse) {
      await db.execute(sql`
        insert into aircraft_positions (hex, ts, lat, lon, alt_ft, gs_kt, track, on_ground, source)
        values (${hex}, ${new Date(ts as number).toISOString()}::timestamptz, ${lat}, ${lon}, ${alt}, 420, 270, false, 'adsb_lol')`);
    }
  });

  afterAll(async () => {
    await db.execute(sql`delete from aircraft_flights where hex = ${hex}`);
    await db.execute(sql`delete from aircraft_positions where hex = ${hex}`);
    await db.execute(sql`delete from corporate_aircraft where icao_hex = ${hex}`);
    await db.execute(
      sql`delete from altdata_coverage where zone like 'air:trace%' and day = '2026-10-14'`,
    );
    await closeDb(db);
  });

  const flights = () =>
    db.execute<{
      departedAt: string;
      arrivedAt: string | null;
      depIcao: string | null;
      arrIcao: string | null;
      completeness: string;
    }>(sql`
      select departed_at as "departedAt", arrived_at as "arrivedAt", dep_icao as "depIcao",
        arr_icao as "arrIcao", completeness
      from aircraft_flights where hex = ${hex} order by departed_at`);

  it("joins the sparse cruise samples into one unknown leg", async () => {
    await deriveAircraftFlights(ctx(), { now: NOW });
    const rows = await flights();
    expect(rows.map((r) => [r.depIcao, r.arrIcao, r.completeness])).toEqual([
      [null, null, "enroute"],
    ]);
  });

  it("stores the full trace and re-derives the leg so both airports resolve", async () => {
    if (!VECC || !VABB) throw new Error("airports missing");
    trace = [
      point(0, VECC.lat, VECC.lon, "ground", 5),
      point(60, VECC.lat + 0.01, VECC.lon - 0.02, 1_500, 160),
      point(90, VECC.lat + 0.02, VECC.lon - 0.05, 1_900, 170),
      point(15 * 60, 22.1, 88.0, 41_000, 420),
      point(80 * 60, 20.1, 75.1, 41_000, 420),
      point(92 * 60, 19.6, 73.9, 20_000, 400),
      point(100 * 60, VABB.lat + 0.1, VABB.lon + 0.2, 3_000, 180),
      point(104 * 60, VABB.lat, VABB.lon, "ground", 20),
      point(105 * 60, VABB.lat, VABB.lon, "ground", 5),
    ];
    const collected = await collectAircraftTraces(ctx(), { now: NOW, aircraftId });
    expect(collected).toMatchObject({ requests: 1, failures: 0, traced: 1 });
    expect(collected.positions).toBe(8);
    expect(requests.at(-1)).toBe(
      `https://adsb.lol/data/traces/${hex.slice(-2)}/trace_full_${hex}.json`,
    );
    expect(collected).toMatchObject({ legs: 1, full: 1, removed: 1 });
    const rows = await flights();
    expect(rows.map((r) => [r.depIcao, r.arrIcao, r.completeness])).toEqual([
      ["VECC", "VABB", "full"],
    ]);
    expect(Date.parse(rows[0]?.departedAt ?? "")).toBe(T0);
    expect(Date.parse(rows[0]?.arrivedAt ?? "")).toBe(T0 + 104 * 60_000);
    await deriveAircraftFlights(ctx(), { now: NOW });
    const collectedAgain = await collectAircraftTraces(ctx(), { now: NOW, aircraftId });
    expect(collectedAgain).toMatchObject({ positions: 0, legs: 1, removed: 0 });
    expect(await flights()).toEqual(rows);
  });

  it("asks for yesterday's history file", async () => {
    trace = [];
    await collectAircraftTraces(ctx(), { now: NOW, day: "yesterday", aircraftId });
    expect(requests.at(-1)).toBe(
      `https://adsb.lol/globe_history/2026/10/13/traces/${hex.slice(-2)}/trace_full_${hex}.json`,
    );
  });

  it("repairs a specific historical day beyond the normal 48-hour replay", async () => {
    if (!VECC || !VABB) throw new Error("airports missing");
    const [aircraft] = await db.execute<{ id: number }>(
      sql`select id from corporate_aircraft where icao_hex = ${hex}`,
    );
    if (!aircraft) throw new Error("test aircraft missing");
    trace = [
      point(0, VECC.lat, VECC.lon, "ground", 5),
      point(60, VECC.lat, VECC.lon, 1500, 160),
      point(30 * 60, 22.1, 88, 41000, 420),
      point(70 * 60, 20.2, 75.5, 41000, 420),
      point(100 * 60, VABB.lat, VABB.lon, 3000, 160),
      point(104 * 60, VABB.lat, VABB.lon, "ground", 5),
    ];
    await db.execute(
      sql`update aircraft_flights set dep_icao = null, arr_icao = null, completeness = 'enroute', parser_version = 1 where hex = ${hex}`,
    );
    const result = await collectAircraftTraces(ctx(), {
      aircraftId: aircraft.id,
      date: "2026-10-14",
      now: new Date("2026-10-20T12:00:00Z"),
    });
    expect(result).toMatchObject({ requests: 1, traced: 1 });
    const [flight] = await db.execute<{
      dep: string;
      arr: string;
      version: number;
      method: string;
    }>(sql`
      select dep_icao as dep, arr_icao as arr, parser_version as version, dep_method as method from aircraft_flights where hex = ${hex}`);
    expect(flight).toMatchObject({ dep: "VECC", arr: "VABB", version: 2, method: "ground" });
    expect(requests.at(-1)).toContain("/globe_history/2026/10/14/");
    await expect(
      collectAircraftTraces(ctx(), { aircraftId: aircraft.id, date: "2026-09-01", now: NOW }),
    ).rejects.toThrow(/30 days/);
  });

  it("reaches older repair days when the first 500 candidates are cooling down", async () => {
    const hexes = Array.from(
      { length: 20 },
      () => `9${randomUUID().replaceAll("-", "").slice(0, 5)}`,
    );
    try {
      await db.execute(sql`insert into corporate_aircraft (registration, icao_hex, tier, confidence, active)
        select 'TEST-' || h, h, 'inferred', 0.5, true from unnest(array[${sql.join(
          hexes.map((h) => sql`${h}`),
          sql`, `,
        )}]::text[]) h`);
      await db.execute(sql`insert into aircraft_flights (aircraft_id, hex, departed_at, arrived_at, completeness, source, dedupe_key)
        select a.id, a.icao_hex, ${NOW.toISOString()}::timestamptz - d * interval '1 day',
          ${NOW.toISOString()}::timestamptz - d * interval '1 day' + interval '1 hour',
          'enroute', 'sampled', 'test:' || a.icao_hex || ':' || d
        from corporate_aircraft a cross join generate_series(1, 26) d where a.icao_hex in ${hexes}`);
      let checked = 0;
      const repairCtx = {
        ...ctx(),
        redis: {
          mget: async (...keys: string[]) => keys.map(() => (checked++ < 500 ? "read" : null)),
        },
      } as unknown as IngestContext;
      const targets = await aircraftRepairTargets(repairCtx, NOW);
      expect(targets.length).toBeGreaterThan(0);
      expect(targets.length).toBeLessThanOrEqual(60);
      expect(checked).toBeGreaterThan(500);
      const sampledCandidates = checked;
      await db.execute(sql`insert into aircraft_flights (aircraft_id, hex, departed_at, arrived_at, completeness, source, dedupe_key)
        values (${aircraftId}, ${hex}, ${NOW.toISOString()}::timestamptz - interval '2 days',
          ${NOW.toISOString()}::timestamptz - interval '2 days' + interval '1 hour',
          'full', 'opensky', ${`provider:${hex}`})`);
      checked = 0;
      await aircraftRepairTargets(repairCtx, NOW);
      expect(checked).toBe(sampledCandidates);
    } finally {
      await db.execute(sql`delete from corporate_aircraft where icao_hex in ${hexes}`);
    }
  });
});
