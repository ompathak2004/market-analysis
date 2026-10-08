import { haversineKm } from "@ma/core";
import { AIRPORT_ROWS } from "./data/airports.js";
import type { Airport, Box } from "./data/types.js";

export { haversineKm };

const RAD = Math.PI / 180;

export function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const y = Math.sin((lon2 - lon1) * RAD) * Math.cos(lat2 * RAD);
  const x =
    Math.cos(lat1 * RAD) * Math.sin(lat2 * RAD) -
    Math.sin(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.cos((lon2 - lon1) * RAD);
  return (Math.atan2(y, x) / RAD + 360) % 360;
}

export function pointInBox(lat: number, lon: number, box: Box): boolean {
  const [[latMin, lonMin], [latMax, lonMax]] = box;
  return lat >= latMin && lat <= latMax && lon >= lonMin && lon <= lonMax;
}

export function bboxOfCircle(lat: number, lon: number, radiusKm: number): Box {
  const dLat = radiusKm / 111.32;
  const dLon = radiusKm / (111.32 * Math.max(0.01, Math.cos(lat * RAD)));
  return [
    [round4(lat - dLat), round4(lon - dLon)],
    [round4(lat + dLat), round4(lon + dLon)],
  ];
}

export function boxesOverlap(a: Box, b: Box): boolean {
  return a[0][0] <= b[1][0] && b[0][0] <= a[1][0] && a[0][1] <= b[1][1] && b[0][1] <= a[1][1];
}

export function mergeBoxes(boxes: readonly Box[]): Box[] {
  let out = [...boxes];
  let merged = true;
  while (merged) {
    merged = false;
    const next: Box[] = [];
    for (const box of out) {
      const i = next.findIndex((b) => boxesOverlap(b, box));
      const hit = i >= 0 ? next[i] : undefined;
      if (hit) {
        next[i] = [
          [Math.min(hit[0][0], box[0][0]), Math.min(hit[0][1], box[0][1])],
          [Math.max(hit[1][0], box[1][0]), Math.max(hit[1][1], box[1][1])],
        ];
        merged = true;
      } else next.push(box);
    }
    out = next;
  }
  return out;
}

function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

export const AIRPORTS: readonly Airport[] = AIRPORT_ROWS.map(
  ([icao, iata, latE4, lonE4, city, country, size]) => ({
    icao,
    iata,
    lat: latE4 / 1e4,
    lon: lonE4 / 1e4,
    city,
    country,
    size,
  }),
);

const BY_ICAO = new Map(AIRPORTS.map((a) => [a.icao, a]));

export function airportByIcao(icao: string | null | undefined): Airport | null {
  return icao ? (BY_ICAO.get(icao.toUpperCase()) ?? null) : null;
}

export function nearestAirport(
  lat: number,
  lon: number,
  maxKm: number,
  opts: { excludeSmall?: boolean } = {},
): { airport: Airport; km: number } | null {
  let best: Airport | null = null;
  let bestKm = maxKm;
  const dLat = maxKm / 111;
  for (const a of AIRPORTS) {
    if (Math.abs(a.lat - lat) > dLat) continue;
    if (opts.excludeSmall && a.size === "S") continue;
    const km = haversineKm(lat, lon, a.lat, a.lon);
    if (km <= bestKm) {
      best = a;
      bestKm = km;
    }
  }
  return best ? { airport: best, km: bestKm } : null;
}
