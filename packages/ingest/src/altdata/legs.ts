import { MINUTE } from "@ma/core";
import type { Airport } from "../data/types.js";
import { nearestAirport } from "../geo.js";

export interface AirSample {
  ts: Date;
  lat: number | null;
  lon: number | null;
  altFt: number | null;
  gsKt: number | null;
  onGround: boolean;
}

export interface Leg<S extends AirSample = AirSample> {
  samples: S[];
  groundBefore: S | null;
  groundAfter: S | null;
  open: boolean;
}

export interface SegmentOptions {
  now?: Date;
  gapMs?: number;
  cruiseGapMs?: number;
  minSamples?: number;
  minDurationMs?: number;
}

export const CRUISE_ALT_FT = 18_000;
export const CRUISE_GAP_MS = 60 * MINUTE;
export const AIRCRAFT_LEG_PARSER_VERSION = 2;

function cruising(s: AirSample): boolean {
  return !s.onGround && s.altFt !== null && s.altFt >= CRUISE_ALT_FT;
}

export function segmentLegs<S extends AirSample>(
  samples: readonly S[],
  opts: SegmentOptions = {},
): Leg<S>[] {
  const gap = opts.gapMs ?? 20 * MINUTE;
  const cruiseGap = opts.cruiseGapMs ?? CRUISE_GAP_MS;
  const minSamples = opts.minSamples ?? 2;
  const minDuration = opts.minDurationMs ?? 10 * MINUTE;
  const now = (opts.now ?? new Date()).getTime();
  const sorted = samples
    .filter((s) => Number.isFinite(s.ts.getTime()) && s.ts.getTime() <= now)
    .sort((a, b) => a.ts.getTime() - b.ts.getTime());
  const legs: Leg<S>[] = [];
  let current: Leg<S> | null = null;
  let lastGround: S | null = null;

  for (const s of sorted) {
    if (s.onGround) {
      if (current) {
        const last = current.samples.at(-1) as S;
        if (s.ts.getTime() - last.ts.getTime() < gap) current.groundAfter = s;
        legs.push(current);
        current = null;
      }
      lastGround = s;
      continue;
    }
    const prev = current?.samples.at(-1);
    if (current && prev) {
      const silence = s.ts.getTime() - prev.ts.getTime();
      const limit = cruising(prev) || cruising(s) ? cruiseGap : gap;
      if (silence >= limit) {
        legs.push(current);
        current = null;
      }
    }
    if (current) {
      current.samples.push(s);
    } else {
      const before =
        lastGround && s.ts.getTime() - lastGround.ts.getTime() < gap ? lastGround : null;
      current = { samples: [s], groundBefore: before, groundAfter: null, open: false };
    }
  }
  if (current) {
    const last = current.samples.at(-1);
    current.open = last !== undefined && now - last.ts.getTime() < gap;
    legs.push(current);
  }

  return legs.filter((leg) => {
    const first = leg.samples[0] as S;
    const last = leg.samples.at(-1) as S;
    const start = (leg.groundBefore ?? first).ts.getTime();
    const end = (leg.groundAfter ?? last).ts.getTime();
    if (leg.samples.length < minSamples) return false;
    return leg.open || end - start >= minDuration;
  });
}

export const GROUND_MATCH_KM = 10;
export const LOW_ALT_MATCH_KM = 40;

export function endpointAirport(sample: AirSample | null, ground: boolean): Airport | null {
  if (
    !sample ||
    sample.lat === null ||
    sample.lon === null ||
    !Number.isFinite(sample.lat) ||
    !Number.isFinite(sample.lon) ||
    Math.abs(sample.lat) > 90 ||
    Math.abs(sample.lon) > 180
  )
    return null;
  if (ground || sample.onGround) {
    return nearestAirport(sample.lat, sample.lon, GROUND_MATCH_KM)?.airport ?? null;
  }
  const low =
    sample.altFt !== null && sample.altFt < 8_000 && (sample.gsKt === null || sample.gsKt < 250);
  if (!low) return null;
  return (
    nearestAirport(sample.lat, sample.lon, LOW_ALT_MATCH_KM, { excludeSmall: true, ambiguityKm: 8 })
      ?.airport ?? null
  );
}

export type Completeness = "full" | "departure_only" | "arrival_only" | "enroute";
export type EndpointMethod = "ground" | "low_altitude";

function resolveEndpoint(
  leg: Leg,
  arrival: boolean,
): { airport: Airport; method: EndpointMethod } | null {
  if (arrival && leg.open) return null;
  const ground = arrival ? leg.groundAfter : leg.groundBefore;
  const observed = endpointAirport(ground, true);
  if (observed) return { airport: observed, method: "ground" };
  const samples = arrival ? [...leg.samples].reverse() : leg.samples;
  const boundary = samples[0] as AirSample;
  for (const sample of samples) {
    if (Math.abs(sample.ts.getTime() - boundary.ts.getTime()) > 3 * MINUTE) break;
    const airport = endpointAirport(sample, false);
    if (airport) return { airport, method: "low_altitude" };
    if (sample.altFt !== null && sample.altFt >= 8_000) break;
  }
  return null;
}

export interface LegSummary {
  firstTs: Date;
  lastTs: Date;
  departedAt: Date;
  arrivedAt: Date | null;
  durationMin: number | null;
  dep: Airport | null;
  arr: Airport | null;
  depMethod: EndpointMethod | null;
  arrMethod: EndpointMethod | null;
  completeness: Completeness;
  samples: number;
  maxAltFt: number | null;
}

export function summarizeLeg(leg: Leg): LegSummary {
  const first = leg.samples[0] as AirSample;
  const last = leg.samples.at(-1) as AirSample;
  const departure = resolveEndpoint(leg, false);
  const arrival = resolveEndpoint(leg, true);
  const dep = departure?.airport ?? null;
  const arr = arrival?.airport ?? null;
  const departedAt = leg.groundBefore ? leg.groundBefore.ts : first.ts;
  const arrivedAt = leg.open ? null : leg.groundAfter ? leg.groundAfter.ts : last.ts;
  const alts = leg.samples.map((s) => s.altFt).filter((a): a is number => a !== null);
  return {
    firstTs: first.ts,
    lastTs: last.ts,
    departedAt,
    arrivedAt,
    durationMin: arrivedAt
      ? Math.round((arrivedAt.getTime() - departedAt.getTime()) / MINUTE)
      : null,
    dep,
    arr,
    depMethod: departure?.method ?? null,
    arrMethod: arrival?.method ?? null,
    completeness: dep && arr ? "full" : dep ? "departure_only" : arr ? "arrival_only" : "enroute",
    samples: leg.samples.length + (leg.groundBefore ? 1 : 0) + (leg.groundAfter ? 1 : 0),
    maxAltFt: alts.length ? Math.max(...alts) : null,
  };
}

export function legDedupeKey(hex: string, firstTs: Date): string {
  return `${hex}:${firstTs.getTime()}`;
}

export interface StoredFlight {
  id: number;
  dedupeKey: string;
  departedAt: Date | null;
  arrivedAt: Date | null;
}

export interface DerivedLeg {
  key: string;
  departedAt: Date;
  endAt: Date;
}

export function replayFrom(flights: readonly StoredFlight[], now: Date, maxMs: number): Date {
  const floor = now.getTime() - maxMs;
  const open = flights.flatMap((f) => (f.arrivedAt === null && f.departedAt ? [f.departedAt] : []));
  const arrived = flights.flatMap((f) => (f.arrivedAt ? [f.arrivedAt] : []));
  const start = open.length
    ? Math.min(...open.map((d) => d.getTime()))
    : arrived.length
      ? Math.max(...arrived.map((d) => d.getTime()))
      : floor;
  return new Date(Math.max(floor, start));
}

export function replayStart(
  flights: readonly StoredFlight[],
  requested: Date | null,
  now: Date,
  maxMs: number,
): Date {
  const floor = now.getTime() - maxMs;
  let start = replayFrom(flights, now, maxMs).getTime();
  if (requested && requested.getTime() < start) start = Math.max(floor, requested.getTime());
  for (const f of flights) {
    if (!f.departedAt || f.departedAt.getTime() >= start) continue;
    if ((f.arrivedAt ?? now).getTime() > start) start = Math.max(floor, f.departedAt.getTime());
  }
  return new Date(start);
}

export function supersededFlights(
  stored: readonly StoredFlight[],
  legs: readonly DerivedLeg[],
  from: Date,
): number[] {
  const keys = new Set(legs.map((l) => l.key));
  return stored
    .filter((f) => {
      if (keys.has(f.dedupeKey) || !f.departedAt) return false;
      const start = f.departedAt.getTime();
      if (f.arrivedAt === null && start >= from.getTime()) return true;
      const end = (f.arrivedAt ?? f.departedAt).getTime();
      return legs.some((l) => start < l.endAt.getTime() && end > l.departedAt.getTime());
    })
    .map((f) => f.id);
}
