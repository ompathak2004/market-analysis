import { createHash } from "node:crypto";

export const sha256 = (input: string | Uint8Array): string =>
  createHash("sha256").update(input).digest("hex");

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function uniqueBy<T>(items: readonly T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const k = key(item);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i] as T, i);
    }
  });
  await Promise.all(workers);
  return results;
}

export function parseIndianNumber(text: string): number | null {
  const cleaned = text.replace(/[₹,\s]/g, "").replace(/^\((.*)\)$/, "-$1");
  if (cleaned === "" || cleaned === "-" || cleaned === "--") return null;
  const n = Number(cleaned.replace(/%$/, ""));
  return Number.isFinite(n) ? n : null;
}

export function median(values: ReadonlyArray<number | null | undefined>): number | null {
  const v = values
    .filter((x): x is number => x != null && Number.isFinite(x))
    .sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? (v[mid] as number) : ((v[mid - 1] as number) + (v[mid] as number)) / 2;
}

export const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

export function addYears(d: Date, years: number): Date {
  const out = new Date(d);
  out.setUTCFullYear(out.getUTCFullYear() + years);
  return out;
}

const EARTH_KM = 6371.0088;
const RAD = Math.PI / 180;

export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = (lat2 - lat1) * RAD;
  const dLon = (lon2 - lon1) * RAD;
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}
