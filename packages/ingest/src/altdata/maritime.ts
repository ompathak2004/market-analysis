import { MID_FLAGS } from "../data/mid-flags.js";
import type { Box } from "../data/types.js";
import { bearingDeg, haversineKm, pointInBox } from "../geo.js";

export type VesselClassName = "tanker" | "gas" | "cargo" | "container" | "passenger" | "other";

export interface SizeEstimate {
  sizeClass: string | null;
  dwtEst: number | null;
  bbl: number | null;
}

const CONTAINER_NAME = /\b(MAERSK|MSC|CMA CGM|EVERGREEN|EVER|HAPAG|ONE|COSCO|OOCL|YANG MING|ZIM)\b/;
const GAS_TEXT = /\b(LNG|LPG|GAS)\b/;

export function vesselClass(
  shipType: number | null,
  name: string | null,
  destination: string | null,
  destinationKind: string | null = null,
): VesselClassName {
  const text = `${name ?? ""} ${destination ?? ""}`.toUpperCase();
  if (shipType !== null && shipType >= 80 && shipType <= 89) {
    return GAS_TEXT.test(text) || destinationKind === "lng_terminal" ? "gas" : "tanker";
  }
  if (shipType !== null && shipType >= 70 && shipType <= 79) {
    return CONTAINER_NAME.test((name ?? "").toUpperCase()) ? "container" : "cargo";
  }
  if (shipType !== null && shipType >= 60 && shipType <= 69) return "passenger";
  return "other";
}

const TANKER_SIZES: ReadonlyArray<readonly [number, string, number, number]> = [
  [320, "VLCC", 300_000, 2_000_000],
  [270, "Suezmax", 150_000, 1_000_000],
  [240, "Aframax/LR2", 110_000, 700_000],
  [220, "Panamax/LR1", 75_000, 500_000],
  [170, "MR", 45_000, 300_000],
];

const BULK_SIZES: ReadonlyArray<readonly [number, string, number]> = [
  [290, "Capesize", 180_000],
  [225, "Panamax", 80_000],
  [180, "Supramax", 58_000],
];

export function sizeClassFor(cls: VesselClassName, lengthM: number | null): SizeEstimate {
  if (lengthM === null || lengthM <= 0) return { sizeClass: null, dwtEst: null, bbl: null };
  if (cls === "tanker") {
    for (const [min, name, dwt, bbl] of TANKER_SIZES) {
      if (lengthM >= min) return { sizeClass: name, dwtEst: dwt, bbl };
    }
    return { sizeClass: "Small tanker", dwtEst: 15_000, bbl: 100_000 };
  }
  if (cls === "cargo") {
    for (const [min, name, dwt] of BULK_SIZES) {
      if (lengthM >= min) return { sizeClass: name, dwtEst: dwt, bbl: null };
    }
    return { sizeClass: "Handy", dwtEst: 35_000, bbl: null };
  }
  return { sizeClass: null, dwtEst: null, bbl: null };
}

export function flagForMmsi(mmsi: number): string | null {
  const s = String(mmsi);
  if (s.length !== 9) return null;
  return MID_FLAGS[Number(s.slice(0, 3))] ?? null;
}

export function isValidImo(imo: number): boolean {
  const s = String(imo);
  if (!/^[1-9]\d{6}$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 6; i++) sum += Number(s[i]) * (7 - i);
  return sum % 10 === Number(s[6]);
}

export function normalizeDestination(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const t = raw
    .toUpperCase()
    .replace(/[^A-Z0-9>]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return t || null;
}

export interface DestinationTarget {
  id: number;
  locode: string | null;
  aliases: readonly string[];
}

export function matchDestination(
  raw: string | null | undefined,
  facilities: readonly DestinationTarget[],
): number | null {
  const norm = normalizeDestination(raw);
  if (!norm) return null;
  const finalLeg = norm.split(">").at(-1)?.trim() ?? norm;
  for (const part of [finalLeg, norm]) {
    const m = /^([A-Z]{2}) ?([A-Z0-9]{3})\b/.exec(part);
    if (m) {
      const code = `${m[1]}${m[2]}`;
      const hit = facilities.find((f) => f.locode === code);
      if (hit) return hit.id;
    }
  }
  const padded = ` ${finalLeg.replace(/>/g, " ")} `;
  let best: { id: number; len: number } | null = null;
  for (const f of facilities) {
    for (const alias of f.aliases) {
      const a = normalizeDestination(alias);
      if (!a) continue;
      if (padded.includes(` ${a} `) && (!best || a.length > best.len))
        best = { id: f.id, len: a.length };
    }
  }
  return best?.id ?? null;
}

export interface VesselPoint {
  ts: Date;
  lat: number;
  lon: number;
  sogKt: number | null;
  navStatus: number | null;
}

export interface CallZone {
  id: number;
  lat: number;
  lon: number;
  radiusKm: number;
}

export interface DerivedCall {
  facilityId: number;
  enteredAt: Date;
  leftAt: Date | null;
  lastInsideAt: Date;
  positions: number;
  navStatusMode: number | null;
  endedBy: "exit" | "timeout" | null;
}

const HOUR = 3_600_000;

function mode(values: number[]): number | null {
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: number | null = null;
  let bestN = 0;
  for (const [v, n] of counts) {
    if (n > bestN) {
      best = v;
      bestN = n;
    }
  }
  return best;
}

interface OpenCall extends DerivedCall {
  outside: number;
  navs: number[];
}

function finishCall(o: OpenCall, endedBy: "exit" | "timeout" | null): DerivedCall {
  return {
    facilityId: o.facilityId,
    enteredAt: o.enteredAt,
    leftAt: endedBy ? o.lastInsideAt : null,
    lastInsideAt: o.lastInsideAt,
    positions: o.positions,
    navStatusMode: mode(o.navs),
    endedBy,
  };
}

export function deriveCalls(
  points: readonly VesselPoint[],
  zones: readonly CallZone[],
  opts: { now?: Date; timeoutMs?: number; exitCount?: number } = {},
): DerivedCall[] {
  const now = (opts.now ?? new Date()).getTime();
  const timeout = opts.timeoutMs ?? 6 * HOUR;
  const exitCount = opts.exitCount ?? 2;
  const sorted = [...points].sort((a, b) => a.ts.getTime() - b.ts.getTime());
  const out: DerivedCall[] = [];
  for (const z of zones) {
    let open: OpenCall | null = null;
    for (const p of sorted) {
      if (open && p.ts.getTime() - open.lastInsideAt.getTime() > timeout) {
        out.push(finishCall(open, "timeout"));
        open = null;
      }
      const inside = haversineKm(p.lat, p.lon, z.lat, z.lon) <= z.radiusKm;
      if (inside && open) {
        open.lastInsideAt = p.ts;
        open.positions++;
        open.outside = 0;
        if (p.navStatus !== null) open.navs.push(p.navStatus);
      } else if (inside) {
        open = {
          facilityId: z.id,
          enteredAt: p.ts,
          leftAt: null,
          lastInsideAt: p.ts,
          positions: 1,
          navStatusMode: null,
          endedBy: null,
          outside: 0,
          navs: p.navStatus !== null ? [p.navStatus] : [],
        };
      } else if (open) {
        open.outside++;
        if (open.outside >= exitCount) {
          out.push(finishCall(open, "exit"));
          open = null;
        }
      }
    }
    if (open) {
      const timedOut = now - open.lastInsideAt.getTime() > timeout;
      out.push(finishCall(open, timedOut ? "timeout" : null));
    }
  }
  return out.sort((a, b) => a.enteredAt.getTime() - b.enteredAt.getTime());
}

export function cargoDirection(
  draughtIn: number | null,
  draughtOut: number | null,
): "import" | "export" | "unknown" {
  if (draughtIn === null || draughtOut === null) return "unknown";
  const delta = draughtOut - draughtIn;
  if (delta <= -0.8) return "import";
  if (delta >= 0.8) return "export";
  return "unknown";
}

export interface TransitZone {
  slug: string;
  box: Box;
}

export interface DerivedTransit {
  chokepoint: string;
  enteredAt: Date;
  leftAt: Date | null;
  lastInsideAt: Date;
  loiterMin: number;
  minSogKt: number | null;
  direction: string;
  positions: number;
}

export function directionFrom(first: VesselPoint, last: VesselPoint): string {
  if (haversineKm(first.lat, first.lon, last.lat, last.lon) < 5) return "unknown";
  const b = bearingDeg(first.lat, first.lon, last.lat, last.lon);
  if (b >= 45 && b < 135) return "eastbound";
  if (b >= 135 && b < 225) return "southbound";
  if (b >= 225 && b < 315) return "westbound";
  return "northbound";
}

const LOITER_STEP_CAP_MIN = 120;

interface OpenTransit {
  t: DerivedTransit;
  first: VesselPoint;
  last: VesselPoint;
  outside: number;
}

function finishTransit(o: OpenTransit, closed: boolean): DerivedTransit {
  return {
    ...o.t,
    leftAt: closed ? o.t.lastInsideAt : null,
    direction: directionFrom(o.first, o.last),
  };
}

function isSlow(p: VesselPoint): boolean {
  return (p.sogKt !== null && p.sogKt < 1) || p.navStatus === 1;
}

export function deriveTransits(
  points: readonly VesselPoint[],
  zones: readonly TransitZone[],
  opts: { now?: Date; timeoutMs?: number; exitCount?: number } = {},
): DerivedTransit[] {
  const now = (opts.now ?? new Date()).getTime();
  const timeout = opts.timeoutMs ?? 12 * HOUR;
  const exitCount = opts.exitCount ?? 2;
  const sorted = [...points].sort((a, b) => a.ts.getTime() - b.ts.getTime());
  const out: DerivedTransit[] = [];
  for (const z of zones) {
    let open: OpenTransit | null = null;
    for (const p of sorted) {
      if (open && p.ts.getTime() - open.t.lastInsideAt.getTime() > timeout) {
        out.push(finishTransit(open, true));
        open = null;
      }
      const inside = pointInBox(p.lat, p.lon, z.box);
      if (inside && open) {
        if (isSlow(p) && isSlow(open.last) && open.outside === 0) {
          const step = (p.ts.getTime() - open.last.ts.getTime()) / 60_000;
          open.t.loiterMin += Math.round(Math.min(step, LOITER_STEP_CAP_MIN));
        }
        open.t.lastInsideAt = p.ts;
        open.t.positions++;
        open.last = p;
        open.outside = 0;
        if (p.sogKt !== null) {
          open.t.minSogKt = open.t.minSogKt === null ? p.sogKt : Math.min(open.t.minSogKt, p.sogKt);
        }
      } else if (inside) {
        open = {
          t: {
            chokepoint: z.slug,
            enteredAt: p.ts,
            leftAt: null,
            lastInsideAt: p.ts,
            loiterMin: 0,
            minSogKt: p.sogKt,
            direction: "unknown",
            positions: 1,
          },
          first: p,
          last: p,
          outside: 0,
        };
      } else if (open) {
        open.outside++;
        if (open.outside >= exitCount) {
          out.push(finishTransit(open, true));
          open = null;
        }
      }
    }
    if (open) out.push(finishTransit(open, now - open.t.lastInsideAt.getTime() > timeout));
  }
  return out.sort((a, b) => a.enteredAt.getTime() - b.enteredAt.getTime());
}
