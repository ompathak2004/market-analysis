import { describe, expect, it } from "vitest";
import { airportByIcao, nearestAirport } from "../geo.js";
import {
  type AirSample,
  endpointAirport,
  legDedupeKey,
  replayFrom,
  type StoredFlight,
  segmentLegs,
  summarizeLeg,
  supersededFlights,
} from "./legs.js";

const MIN = 60_000;
const T0 = Date.parse("2026-10-01T04:00:00Z");
const VABB = airportByIcao("VABB");
const VIDP = airportByIcao("VIDP");

function sample(
  minute: number,
  lat: number,
  lon: number,
  onGround: boolean,
  altFt: number | null = onGround ? null : 30_000,
): AirSample {
  return { ts: new Date(T0 + minute * MIN), lat, lon, altFt, gsKt: onGround ? 10 : 420, onGround };
}

describe("nearestAirport", () => {
  it("matches the closest airport inside the radius and nothing beyond it", () => {
    if (!VABB) throw new Error("VABB missing");
    expect(nearestAirport(VABB.lat + 0.02, VABB.lon + 0.03, 10)?.airport.icao).toBe("VABB");
    expect(nearestAirport(VABB.lat - 0.54, VABB.lon - 0.3, 60, { excludeSmall: true })).toBeNull();
  });

  it("only uses the wide low-altitude radius for descending aircraft", () => {
    if (!VABB) throw new Error("VABB missing");
    const near = { ...sample(0, VABB.lat + 0.2, VABB.lon + 0.05, false, 4_000), gsKt: 180 };
    expect(endpointAirport(near, false)?.icao).toBe("VABB");
    expect(endpointAirport({ ...near, altFt: 35_000, gsKt: 450 }, false)).toBeNull();
  });
});

describe("segmentLegs", () => {
  it("splits on ground contact and gaps and keeps the bracketing ground samples", () => {
    if (!VABB || !VIDP) throw new Error("airports missing");
    const cruise = Array.from({ length: 12 }, (_, i) =>
      sample(
        5 + i * 10,
        VABB.lat + ((VIDP.lat - VABB.lat) * i) / 11,
        VABB.lon + ((VIDP.lon - VABB.lon) * i) / 11,
        false,
        i === 11 ? 3_000 : 30_000,
      ),
    );
    const samples = [
      sample(0, VABB.lat, VABB.lon, true),
      ...cruise,
      sample(125, VIDP.lat, VIDP.lon, true),
      sample(400, 26, 76, false),
      sample(410, 26.2, 76.2, false),
      sample(420, 26.4, 76.4, false),
    ];
    const legs = segmentLegs(samples, { now: new Date(T0 + 2_000 * MIN) });
    expect(legs).toHaveLength(2);
    const first = legs[0];
    if (!first) throw new Error("no leg");
    expect(first.groundBefore?.ts.getTime()).toBe(T0);
    expect(first.groundAfter?.ts.getTime()).toBe(T0 + 125 * MIN);
    const summary = summarizeLeg(first);
    expect(summary.dep?.icao).toBe("VABB");
    expect(summary.arr?.icao).toBe("VIDP");
    expect(summary.completeness).toBe("full");
    expect(summary.durationMin).toBe(125);
    expect(summarizeLeg(legs[1] as (typeof legs)[number]).completeness).toBe("enroute");
  });

  it("marks the trailing leg open while samples are fresh and drops single-sample blips", () => {
    const legs = segmentLegs([sample(0, 20, 75, false), sample(3, 20.2, 75.1, false)], {
      now: new Date(T0 + 5 * MIN),
    });
    expect(legs).toHaveLength(1);
    expect(legs[0]?.open).toBe(true);
    expect(segmentLegs([sample(0, 20, 75, false)], { now: new Date(T0 + 500 * MIN) })).toEqual([]);
  });

  it("buckets dedupe keys by half hour", () => {
    expect(legDedupeKey("80abcd", new Date(T0 + 5 * MIN))).toBe(
      legDedupeKey("80abcd", new Date(T0 + 25 * MIN)),
    );
  });
});

describe("incremental flight derivation", () => {
  const MAX = 48 * 60 * MIN;

  function trip(): AirSample[] {
    if (!VABB || !VIDP) throw new Error("airports missing");
    const cruise = Array.from({ length: 24 }, (_, i) =>
      sample(
        5 + i * 5,
        VABB.lat + ((VIDP.lat - VABB.lat) * i) / 23,
        VABB.lon + ((VIDP.lon - VABB.lon) * i) / 23,
        false,
        i === 23 ? 3_000 : 30_000,
      ),
    );
    return [sample(0, VABB.lat, VABB.lon, true), ...cruise, sample(125, VIDP.lat, VIDP.lon, true)];
  }

  function derive(store: Map<string, StoredFlight>, samples: AirSample[], nowMin: number) {
    const now = new Date(T0 + nowMin * MIN);
    const stored = [...store.values()];
    const from = replayFrom(stored, now, MAX);
    const visible = samples.filter((s) => s.ts <= now && s.ts >= from);
    const legs = segmentLegs(visible, { now }).map((leg) => {
      const sum = summarizeLeg(leg);
      const key = legDedupeKey("80abcd", sum.firstTs);
      const prev = store.get(key);
      store.set(key, {
        id: prev?.id ?? store.size + 1 + nowMin * 1000,
        dedupeKey: key,
        departedAt: sum.departedAt,
        arrivedAt: sum.arrivedAt,
      });
      return { key, departedAt: sum.departedAt, endAt: sum.arrivedAt ?? sum.lastTs };
    });
    const removed = new Set(supersededFlights(stored, legs, from));
    for (const [key, f] of store) if (removed.has(f.id)) store.delete(key);
  }

  it("keeps one row per trip across overlapping passes and long after it lands", () => {
    const samples = trip();
    const store = new Map<string, StoredFlight>();
    for (const nowMin of [12, 42, 72, 102, 132, 162, 400, 3_000]) derive(store, samples, nowMin);
    const flights = [...store.values()];
    expect(flights).toHaveLength(1);
    expect(flights[0]?.departedAt?.getTime()).toBe(T0);
    expect(flights[0]?.arrivedAt?.getTime()).toBe(T0 + 125 * MIN);
  });

  it("replays from the earliest open flight, else the last landing", () => {
    const now = new Date(T0 + 600 * MIN);
    const done = {
      id: 1,
      dedupeKey: "a",
      departedAt: new Date(T0),
      arrivedAt: new Date(T0 + 90 * MIN),
    };
    const open = { id: 2, dedupeKey: "b", departedAt: new Date(T0 + 300 * MIN), arrivedAt: null };
    expect(replayFrom([done], now, MAX).getTime()).toBe(T0 + 90 * MIN);
    expect(replayFrom([done, open], now, MAX).getTime()).toBe(T0 + 300 * MIN);
    expect(replayFrom([], now, MAX).getTime()).toBe(now.getTime() - MAX);
  });

  it("removes a completed row that a re-derived leg overlaps under another key", () => {
    const truncated = {
      id: 7,
      dedupeKey: "80abcd:old",
      departedAt: new Date(T0 + 40 * MIN),
      arrivedAt: new Date(T0 + 125 * MIN),
    };
    const earlier = {
      id: 8,
      dedupeKey: "80abcd:earlier",
      departedAt: new Date(T0 - 300 * MIN),
      arrivedAt: new Date(T0 - 200 * MIN),
    };
    const leg = { key: "80abcd:new", departedAt: new Date(T0), endAt: new Date(T0 + 125 * MIN) };
    expect(supersededFlights([truncated, earlier], [leg], new Date(T0))).toEqual([7]);
  });
});
