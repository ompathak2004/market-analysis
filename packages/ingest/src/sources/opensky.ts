import type { RedisClient } from "@ma/cache";
import type { Logger } from "@ma/core";
import type { HttpClient } from "../http.js";

const TOKEN_URL =
  "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token";
const API = "https://opensky-network.org/api";
const DISABLED_KEY = "altdata:opensky:disabled";
const TOKEN_KEY = "altdata:opensky:token";
const DISABLE_SECONDS = 6 * 3600;

export interface OpenSkyFlight {
  icao24: string;
  firstSeen: Date;
  lastSeen: Date;
  depIcao: string | null;
  arrIcao: string | null;
  callsign: string | null;
}

interface OpenSkyFlightRaw {
  icao24?: string;
  firstSeen?: number;
  lastSeen?: number;
  estDepartureAirport?: string | null;
  estArrivalAirport?: string | null;
  callsign?: string | null;
}

export class OpenSkySource {
  constructor(
    private readonly http: HttpClient,
    private readonly redis: RedisClient,
    private readonly logger: Logger,
    private readonly creds: { clientId: string; clientSecret: string } | null,
  ) {}

  async available(): Promise<boolean> {
    if (!this.creds) return false;
    return (await this.redis.exists(DISABLED_KEY)) === 0;
  }

  async disable(reason: string): Promise<void> {
    this.logger.warn({ reason }, "opensky disabled for 6h");
    await this.redis.set(DISABLED_KEY, reason.slice(0, 200), "EX", DISABLE_SECONDS);
  }

  async flightsForAircraft(hex: string, begin: Date, end: Date): Promise<OpenSkyFlight[]> {
    const token = await this.token();
    const qs = `icao24=${hex.toLowerCase()}&begin=${Math.floor(begin.getTime() / 1000)}&end=${Math.floor(end.getTime() / 1000)}`;
    const res = await this.http.get(`${API}/flights/aircraft?${qs}`, {
      headers: { accept: "application/json", authorization: `Bearer ${token}` },
      timeoutMs: 8_000,
      retries: 0,
    });
    if (res.status === 404) return [];
    if (res.status !== 200) throw new Error(`opensky status ${res.status}`);
    const rows = JSON.parse(res.text()) as OpenSkyFlightRaw[];
    return rows
      .filter((r) => r.icao24 && r.firstSeen && r.lastSeen)
      .map((r) => ({
        icao24: (r.icao24 as string).toLowerCase(),
        firstSeen: new Date((r.firstSeen as number) * 1000),
        lastSeen: new Date((r.lastSeen as number) * 1000),
        depIcao: r.estDepartureAirport ?? null,
        arrIcao: r.estArrivalAirport ?? null,
        callsign: r.callsign?.trim() || null,
      }));
  }

  private async token(): Promise<string> {
    const cached = await this.redis.get(TOKEN_KEY);
    if (cached) return cached;
    if (!this.creds) throw new Error("opensky credentials missing");
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.creds.clientId,
      client_secret: this.creds.clientSecret,
    }).toString();
    const res = await this.http.post(TOKEN_URL, body, {
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      timeoutMs: 8_000,
      retries: 0,
    });
    if (res.status !== 200) throw new Error(`opensky token status ${res.status}`);
    const json = JSON.parse(res.text()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) throw new Error("opensky token missing");
    const ttl = Math.max(60, (json.expires_in ?? 1800) - 60);
    await this.redis.set(TOKEN_KEY, json.access_token, "EX", ttl);
    return json.access_token;
  }
}
