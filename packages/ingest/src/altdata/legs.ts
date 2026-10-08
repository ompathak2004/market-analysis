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
  minSamples?: number;
  minDurationMs?: number;
}

export function segmentLegs<S extends AirSample>(
  samples: readonly S[],
  opts: SegmentOptions = {},
): Leg<S>[] {
  const gap = opts.gapMs ?? 20 * MINUTE;
  const minSamples = opts.minSamples ?? 2;
  const minDuration = opts.minDurationMs ?? 10 * MINUTE;
  const now = (opts.now ?? new Date()).getTime();
  const sorted = [...samples].sort((a, b) => a.ts.getTime() - b.ts.getTime());
  const legs: Leg<S>[] = [];
  let current: Leg<S> | null = null;
  let lastGround: S | null = null;

  for (const s of sorted) {
    if (s.onGround) {
      if (current) {
        current.groundAfter = s;
        legs.push(current);
        current = null;
      }
      lastGround = s;
      continue;
    }
    const prev = current?.samples.at(-1);
    if (current && prev && s.ts.getTime() - prev.ts.getTime() >= gap) {
      legs.push(current);
      current = null;
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
  if (!sample || sample.lat === null || sample.lon === null) return null;
  if (ground || sample.onGround) {
    return nearestAirport(sample.lat, sample.lon, GROUND_MATCH_KM)?.airport ?? null;
  }
  const low = (sample.altFt !== null && sample.altFt < 8_000) || (sample.gsKt ?? 999) < 200;
  if (!low) return null;
  return (
    nearestAirport(sample.lat, sample.lon, LOW_ALT_MATCH_KM, { excludeSmall: true })?.airport ??
    null
  );
}

export type Completeness = "full" | "departure_only" | "arrival_only" | "enroute";

export interface LegSummary {
  firstTs: Date;
  lastTs: Date;
  departedAt: Date;
  arrivedAt: Date | null;
  durationMin: number | null;
  dep: Airport | null;
  arr: Airport | null;
  completeness: Completeness;
  samples: number;
  maxAltFt: number | null;
}

export function summarizeLeg(leg: Leg): LegSummary {
  const first = leg.samples[0] as AirSample;
  const last = leg.samples.at(-1) as AirSample;
  const dep = endpointAirport(leg.groundBefore ?? first, leg.groundBefore !== null);
  const arr = leg.open ? null : endpointAirport(leg.groundAfter ?? last, leg.groundAfter !== null);
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
    completeness: dep && arr ? "full" : dep ? "departure_only" : arr ? "arrival_only" : "enroute",
    samples: leg.samples.length + (leg.groundBefore ? 1 : 0) + (leg.groundAfter ? 1 : 0),
    maxAltFt: alts.length ? Math.max(...alts) : null,
  };
}

export function legDedupeKey(hex: string, firstTs: Date): string {
  return `${hex}:${Math.floor(firstTs.getTime() / (30 * MINUTE))}`;
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
      return legs.some((l) => start <= l.endAt.getTime() && end >= l.departedAt.getTime());
    })
    .map((f) => f.id);
}
