import type { HttpClient } from "../http.js";

const BASE = "https://api.adsb.lol";

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

  private async fetch(path: string): Promise<PositionSample[]> {
    const res = await this.http.get(`${BASE}${path}`, {
      headers: { accept: "application/json" },
      timeoutMs: 20_000,
    });
    if (res.status !== 200) return [];
    return normalizeAdsb(JSON.parse(res.text()) as AdsbLolResponse);
  }
}
