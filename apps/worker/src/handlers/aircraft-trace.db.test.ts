import { randomUUID } from "node:crypto";
import { createLogger } from "@ma/core";
import { closeDb, createDb, type Db, sql } from "@ma/db";
import {
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
  hashes = new Map<string, Map<string, string>>();
  sets = new Map<string, Set<string>>();
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
  async expire() {
    return 1;
  }
  async exists(k: string) {
    return this.strings.has(k) ? 1 : 0;
  }
  async hget(k: string, f: string) {
    return this.hashes.get(k)?.get(f) ?? null;
  }
  async hset(k: string, f: string | Record<string, string>, v?: string) {
    const h = this.hashes.get(k) ?? new Map<string, string>();
    if (typeof f === "string") h.set(f, v as string);
    else for (const [a, b] of Object.entries(f)) h.set(a, b);
    this.hashes.set(k, h);
    return 1;
  }
  async hdel(k: string, f: string) {
    return this.hashes.get(k)?.delete(f) ? 1 : 0;
  }
  async hgetall(k: string) {
    return Object.fromEntries(this.hashes.get(k) ?? []);
  }
  async smembers(k: string) {
    return [...(this.sets.get(k) ?? [])];
  }
  async sadd(k: string, ...m: string[]) {
    const s = this.sets.get(k) ?? new Set<string>();
    for (const x of m) s.add(x);
    this.sets.set(k, s);
    return m.length;
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
    await db.execute(sql`
      insert into corporate_aircraft (registration, icao_hex, tier, confidence, active, last_seen_at)
      values (${registration}, ${hex}, 'registry', 0.9, true, ${NOW.toISOString()}::timestamptz)`);
    const sparse = [
      [T0 + 15 * 60_000, 22.1, 88.0, 41_000],
      [T0 + 20 * 60_000, 22.0, 87.3, 41_000],
      [T0 + 25 * 60_000, 21.9, 86.6, 41_000],
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

  it("stores the full trace and replays the window so both airports resolve", async () => {
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
    const collected = await collectAircraftTraces(ctx(), { now: NOW });
    expect(collected).toMatchObject({ requests: 1, failures: 0, traced: 1 });
    expect(collected.positions).toBe(7);
    expect(requests.at(-1)).toBe(
      `https://adsb.lol/data/traces/${hex.slice(-2)}/trace_full_${hex}.json`,
    );
    expect(await redis.hget("altdata:air:replay", hex)).toBe(String(T0));

    await deriveAircraftFlights(ctx(), { now: NOW });
    const rows = await flights();
    expect(rows.map((r) => [r.depIcao, r.arrIcao, r.completeness])).toEqual([
      ["VECC", "VABB", "full"],
    ]);
    expect(Date.parse(rows[0]?.departedAt ?? "")).toBe(T0);
    expect(Date.parse(rows[0]?.arrivedAt ?? "")).toBe(T0 + 104 * 60_000);
    expect(await redis.hget("altdata:air:replay", hex)).toBeNull();
    const collectedAgain = await collectAircraftTraces(ctx(), { now: NOW });
    expect(collectedAgain.positions).toBe(0);
    expect(await redis.hget("altdata:air:replay", hex)).toBeNull();
  });

  it("asks for yesterday's history file", async () => {
    trace = [];
    await collectAircraftTraces(ctx(), { now: NOW, day: "yesterday" });
    expect(requests.at(-1)).toBe(
      `https://adsb.lol/globe_history/2026/10/13/traces/${hex.slice(-2)}/trace_full_${hex}.json`,
    );
  });
});
