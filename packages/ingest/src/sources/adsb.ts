import type { HttpClient } from "../http.js";

const BASE = "https://api.adsb.lol";
const TRACE_BASE = "https://adsb.lol";
const TRACE_STALE = 1;
export const TRACE_MIN_SPACING_MS = 30_000;

export interface PositionSample {
  hex: string;
  ts: Date;
  lat: number;
  lon: number;
  altFt: number | null;
  gsKt: number | null;
  track: number | null;
  onGround: boolean;
  squawk: string | null;
  registration: string | null;
  icaoType: string | null;
  callsign: string | null;
}

interface AdsbLolAircraft {
  hex?: string;
  flight?: string;
  r?: string;
  t?: string;
  alt_baro?: number | "ground";
  gs?: number;
  track?: number;
  true_heading?: number;
  lat?: number;
  lon?: number;
  seen_pos?: number;
  squawk?: string;
}

interface AdsbLolResponse {
  ac?: AdsbLolAircraft[];
  now?: number;
}

export function normalizeAdsb(body: AdsbLolResponse, nowMs = Date.now()): PositionSample[] {
  const now = typeof body.now === "number" ? body.now : nowMs;
  const out: PositionSample[] = [];
  for (const a of body.ac ?? []) {
    if (!a.hex || typeof a.lat !== "number" || typeof a.lon !== "number") continue;
    const onGround = a.alt_baro === "ground";
    const ts = Math.round((now - (a.seen_pos ?? 0) * 1000) / 1000) * 1000;
    out.push({
      hex: a.hex.toLowerCase().replace(/^~/, ""),
      ts: new Date(ts),
      lat: a.lat,
      lon: a.lon,
      altFt: typeof a.alt_baro === "number" ? Math.round(a.alt_baro) : null,
      gsKt: a.gs ?? null,
      track: a.track ?? a.true_heading ?? null,
      onGround,
      squawk: a.squawk ?? null,
      registration: a.r?.toUpperCase() ?? null,
      icaoType: a.t?.toUpperCase() ?? null,
      callsign: a.flight?.trim() || null,
    });
  }
  return out;
}

type TracePoint = [
  number,
  number,
  number,
  number | "ground" | null,
  number | null,
  number | null,
  number,
  number | null,
  { flight?: string; squawk?: string } | null,
  ...unknown[],
];

export interface AdsbLolTrace {
  icao?: string;
  r?: string;
  t?: string;
  timestamp?: number;
  trace?: TracePoint[];
}

export function normalizeTrace(body: AdsbLolTrace, hex: string): PositionSample[] {
  const base = body.timestamp;
  if (typeof base !== "number" || !Array.isArray(body.trace)) return [];
  const out: PositionSample[] = [];
  let kept: PositionSample | null = null;
  const points = body.trace;
  points.forEach((p, i) => {
    if (typeof p[1] !== "number" || typeof p[2] !== "number" || p[6] & TRACE_STALE) return;
    const onGround = p[3] === "ground";
    const sample: PositionSample = {
      hex,
      ts: new Date(Math.round(base + p[0]) * 1000),
      lat: p[1],
      lon: p[2],
      altFt: typeof p[3] === "number" ? Math.round(p[3]) : null,
      gsKt: p[4] ?? null,
      track: p[5] ?? null,
      onGround,
      squawk: p[8]?.squawk ?? kept?.squawk ?? null,
      registration: body.r?.toUpperCase() ?? null,
      icaoType: body.t?.toUpperCase() ?? null,
      callsign: p[8]?.flight?.trim() || kept?.callsign || null,
    };
    const transition = kept !== null && kept.onGround !== onGround;
    const spaced = kept === null || sample.ts.getTime() - kept.ts.getTime() >= TRACE_MIN_SPACING_MS;
    if (!transition && !spaced && i < points.length - 1) return;
    if (kept && sample.ts.getTime() === kept.ts.getTime()) out.pop();
    out.push(sample);
    kept = sample;
  });
  return out;
}

export function traceDay(now: Date, daysAgo: number): string {
  const d = new Date(now.getTime() - daysAgo * 86_400_000);
  return d.toISOString().slice(0, 10);
}

export class AdsbSource {
  constructor(private readonly http: HttpClient) {}

  byType(icaoType: string): Promise<PositionSample[]> {
    return this.fetch(`/v2/type/${encodeURIComponent(icaoType.toUpperCase())}`);
  }

  byHex(hex: string | readonly string[]): Promise<PositionSample[]> {
    const list = (typeof hex === "string" ? [hex] : hex).map((h) => h.toLowerCase());
    return this.fetch(`/v2/hex/${list.map(encodeURIComponent).join(",")}`);
  }

  point(lat: number, lon: number, radiusNm: number): Promise<PositionSample[]> {
    const nm = Math.min(250, Math.max(1, Math.round(radiusNm)));
    return this.fetch(`/v2/point/${lat.toFixed(4)}/${lon.toFixed(4)}/${nm}`);
  }

  async trace(hex: string, day: string | null): Promise<PositionSample[]> {
    const h = hex.toLowerCase();
    const file = `traces/${h.slice(-2)}/trace_full_${h}.json`;
    const url = day
      ? `${TRACE_BASE}/globe_history/${day.replaceAll("-", "/")}/${file}`
      : `${TRACE_BASE}/data/traces/${h.slice(-2)}/trace_full_${h}.json`;
    const res = await this.http.get(url, {
      headers: { accept: "application/json" },
      timeoutMs: 20_000,
    });
    if (res.status !== 200) return [];
    return normalizeTrace(JSON.parse(res.text()) as AdsbLolTrace, h);
  }

  private async fetch(path: string): Promise<PositionSample[]> {
    const res = await this.http.get(`${BASE}${path}`, {
      headers: { accept: "application/json" },
      timeoutMs: 20_000,
    });
    if (res.status !== 200) return [];
    return normalizeAdsb(JSON.parse(res.text()) as AdsbLolResponse);
  }
}
