import { gunzipSync } from "node:zlib";
import type { RedisClient } from "@ma/cache";
import type { HttpClient } from "../http.js";

export const AIRCRAFT_DB_PARSER_VERSION = 1;
export const AIRCRAFT_DB_URL =
  "https://github.com/wiedehopf/tar1090-db/raw/refs/heads/csv/aircraft.csv.gz";

const ETAG_KEY = "altdata:aircraftdb:etag";
const FETCHED_KEY = "altdata:aircraftdb:fetched_at";
const WEEK_MS = 7 * 86_400_000;

export interface AircraftDbRow {
  hex: string;
  registration: string;
  icaoType: string | null;
  model: string | null;
  military: boolean;
  privacy: boolean;
  ladd: boolean;
}

export function parseFlags(flags: string): { military: boolean; pia: boolean; ladd: boolean } {
  const bit = (i: number) => (flags[i] ?? "0") === "1";
  return { military: bit(0), pia: bit(2), ladd: bit(3) };
}

export function parseAircraftDb(text: string, prefix = "VT-"): AircraftDbRow[] {
  const out: AircraftDbRow[] = [];
  for (const line of text.split("\n")) {
    const cols = line.split(";");
    const reg = cols[1]?.trim().toUpperCase();
    const hex = cols[0]?.trim().toLowerCase();
    if (!reg || !hex || !reg.startsWith(prefix) || !/^[0-9a-f]{6}$/.test(hex)) continue;
    const flags = parseFlags(cols[3]?.trim() ?? "");
    out.push({
      hex,
      registration: reg,
      icaoType: cols[2]?.trim().toUpperCase() || null,
      model: cols[4]?.trim() || null,
      military: flags.military,
      privacy: flags.pia || flags.ladd,
      ladd: flags.ladd,
    });
  }
  return out;
}

export async function downloadAircraftDb(
  http: HttpClient,
  redis: RedisClient,
  opts: { force?: boolean } = {},
): Promise<AircraftDbRow[] | null> {
  const [etag, fetchedAt] = await Promise.all([redis.get(ETAG_KEY), redis.get(FETCHED_KEY)]);
  const fresh = fetchedAt && Date.now() - Number(fetchedAt) < WEEK_MS;
  if (fresh && !opts.force) return null;
  const res = await http.get(AIRCRAFT_DB_URL, {
    etag: opts.force ? null : etag,
    timeoutMs: 60_000,
    headers: { accept: "application/octet-stream,*/*" },
  });
  await redis.set(FETCHED_KEY, String(Date.now()));
  if (res.notModified || res.status !== 200) return null;
  const newEtag = res.headers.get("etag");
  if (newEtag) await redis.set(ETAG_KEY, newEtag);
  return parseAircraftDb(gunzipSync(res.body).toString("utf8"));
}

export interface AdsbdbAircraft {
  modeS: string | null;
  registration: string | null;
  owner: string | null;
  icaoType: string | null;
  model: string | null;
}

interface AdsbdbResponse {
  response?: {
    aircraft?: {
      type?: string;
      icao_type?: string;
      manufacturer?: string;
      mode_s?: string;
      registration?: string;
      registered_owner?: string;
    };
  };
}

export async function lookupAdsbdb(http: HttpClient, key: string): Promise<AdsbdbAircraft | null> {
  const res = await http.get(`https://api.adsbdb.com/v0/aircraft/${encodeURIComponent(key)}`, {
    headers: { accept: "application/json" },
    timeoutMs: 15_000,
  });
  if (res.status !== 200) return null;
  const a = (JSON.parse(res.text()) as AdsbdbResponse).response?.aircraft;
  if (!a) return null;
  return {
    modeS: a.mode_s?.toLowerCase() ?? null,
    registration: a.registration?.toUpperCase() ?? null,
    owner: a.registered_owner?.trim() || null,
    icaoType: a.icao_type?.toUpperCase() ?? null,
    model: [a.manufacturer, a.type].filter(Boolean).join(" ") || null,
  };
}
