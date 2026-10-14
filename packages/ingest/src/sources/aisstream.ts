import type { Logger } from "@ma/core";
import type { Box } from "../data/types.js";

const URL = "wss://stream.aisstream.io/v0/stream";

export interface AisPosition {
  mmsi: number;
  ts: Date;
  lat: number;
  lon: number;
  sogKt: number | null;
  cogDeg: number | null;
  headingDeg: number | null;
  navStatus: number | null;
}

export interface AisStatic {
  mmsi: number;
  ts: Date;
  imo: number | null;
  name: string | null;
  callSign: string | null;
  shipType: number | null;
  lengthM: number | null;
  beamM: number | null;
  draughtM: number | null;
  destination: string | null;
  eta: string | null;
}

export type AisMessage =
  | { kind: "position"; position: AisPosition; name: string | null }
  | { kind: "static"; static: AisStatic }
  | { kind: "confirm" }
  | { kind: "error"; error: string }
  | { kind: "other" };

export interface AisCollectStats {
  messages: number;
  positions: number;
  statics: number;
  reconnects: number;
  errors: number;
  confirmed: number;
}

export interface AisCollectResult {
  positions: AisPosition[];
  statics: Map<number, AisStatic>;
  names: Map<number, string>;
  stats: AisCollectStats;
}

interface RawMeta {
  MMSI?: number;
  ShipName?: string;
  latitude?: number;
  longitude?: number;
  time_utc?: string;
}

interface RawEnvelope {
  MessageType?: string;
  MetaData?: RawMeta;
  Message?: {
    PositionReport?: {
      UserID?: number;
      Latitude?: number;
      Longitude?: number;
      Sog?: number;
      Cog?: number;
      TrueHeading?: number;
      NavigationalStatus?: number;
    };
    ShipStaticData?: {
      UserID?: number;
      ImoNumber?: number;
      CallSign?: string;
      Name?: string;
      Type?: number;
      Dimension?: { A?: number; B?: number; C?: number; D?: number };
      Eta?: { Month?: number; Day?: number; Hour?: number; Minute?: number };
      MaximumStaticDraught?: number;
      Destination?: string;
    };
  };
  error?: string;
}

export function parseAisTime(raw: string | undefined, fallback: Date): Date {
  if (!raw) return fallback;
  const d = new Date(`${raw.slice(0, 19).replace(" ", "T")}Z`);
  return Number.isNaN(d.getTime()) ? fallback : d;
}

function cleanText(s: string | undefined): string | null {
  const t = s?.replace(/@+/g, " ").replace(/\s+/g, " ").trim();
  return t ? t : null;
}

function positive(n: number | undefined): number | null {
  return typeof n === "number" && n > 0 ? n : null;
}

export function parseAisMessage(json: RawEnvelope, now = new Date()): AisMessage {
  if (json.error) return { kind: "error", error: String(json.error) };
  if (json.MessageType === "SubscriptionConfirmation") return { kind: "confirm" };
  const meta = json.MetaData ?? {};
  const ts = parseAisTime(meta.time_utc, now);
  const p = json.Message?.PositionReport;
  if (json.MessageType === "PositionReport" && p) {
    const mmsi = p.UserID ?? meta.MMSI;
    const lat = p.Latitude ?? meta.latitude;
    const lon = p.Longitude ?? meta.longitude;
    if (!mmsi || typeof lat !== "number" || typeof lon !== "number") return { kind: "other" };
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return { kind: "other" };
    return {
      kind: "position",
      name: cleanText(meta.ShipName),
      position: {
        mmsi,
        ts,
        lat,
        lon,
        sogKt: typeof p.Sog === "number" && p.Sog < 102.3 ? p.Sog : null,
        cogDeg: typeof p.Cog === "number" && p.Cog < 360 ? p.Cog : null,
        headingDeg: typeof p.TrueHeading === "number" && p.TrueHeading < 360 ? p.TrueHeading : null,
        navStatus: typeof p.NavigationalStatus === "number" ? p.NavigationalStatus : null,
      },
    };
  }
  const s = json.Message?.ShipStaticData;
  if (json.MessageType === "ShipStaticData" && s) {
    const mmsi = s.UserID ?? meta.MMSI;
    if (!mmsi) return { kind: "other" };
    const d = s.Dimension ?? {};
    const length = (d.A ?? 0) + (d.B ?? 0);
    const beam = (d.C ?? 0) + (d.D ?? 0);
    const eta = s.Eta;
    return {
      kind: "static",
      static: {
        mmsi,
        ts,
        imo: positive(s.ImoNumber),
        name: cleanText(s.Name) ?? cleanText(meta.ShipName),
        callSign: cleanText(s.CallSign),
        shipType: typeof s.Type === "number" ? s.Type : null,
        lengthM: length > 0 && length < 500 ? length : null,
        beamM: beam > 0 && beam < 100 ? beam : null,
        draughtM: positive(s.MaximumStaticDraught),
        destination: cleanText(s.Destination),
        eta:
          eta?.Month && eta.Day
            ? `${String(eta.Month).padStart(2, "0")}-${String(eta.Day).padStart(2, "0")} ${String(eta.Hour ?? 0).padStart(2, "0")}:${String(eta.Minute ?? 0).padStart(2, "0")}`
            : null,
      },
    };
  }
  return { kind: "other" };
}

export interface CollectAisOptions {
  apiKey: string;
  boxes: readonly Box[];
  mmsiFilter?: readonly number[];
  seconds: number;
  maxMessages: number;
  deadline: number;
  logger: Logger;
}

const BACKOFF_MS = [1_000, 2_000, 4_000];

export async function collectAis(opts: CollectAisOptions): Promise<AisCollectResult> {
  const positions = new Map<string, AisPosition>();
  const statics = new Map<number, AisStatic>();
  const names = new Map<number, string>();
  const stats: AisCollectStats = {
    messages: 0,
    positions: 0,
    statics: 0,
    reconnects: 0,
    errors: 0,
    confirmed: 0,
  };
  const started = Date.now();
  const endAt = Math.min(started + opts.seconds * 1000, opts.deadline);
  const switchAt = started + Math.floor(opts.seconds * 667);
  const fleet = opts.mmsiFilter?.length ? [...opts.mmsiFilter] : null;

  const handle = (msg: AisMessage): boolean => {
    stats.messages++;
    if (msg.kind === "position") {
      const key = `${msg.position.mmsi}:${Math.floor(msg.position.ts.getTime() / 1000)}`;
      if (!positions.has(key)) positions.set(key, msg.position);
      if (msg.name) names.set(msg.position.mmsi, msg.name);
    } else if (msg.kind === "static") {
      statics.set(msg.static.mmsi, msg.static);
    } else if (msg.kind === "confirm") {
      stats.confirmed++;
    } else if (msg.kind === "error") {
      stats.errors++;
      opts.logger.warn({ error: msg.error }, "aisstream error message");
    }
    return stats.messages >= opts.maxMessages;
  };

  for (let attempt = 0; Date.now() < endAt - 1_000; attempt++) {
    if (attempt > 0) {
      if (attempt > BACKOFF_MS.length) break;
      stats.reconnects++;
      await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt - 1]));
      if (Date.now() >= endAt - 1_000) break;
    }
    const closedCleanly = await runSocket(opts, endAt, fleet ? switchAt : null, fleet, handle);
    if (closedCleanly) break;
  }

  const list = [...positions.values()];
  stats.positions = list.length;
  stats.statics = statics.size;
  return { positions: list, statics, names, stats };
}

function runSocket(
  opts: CollectAisOptions,
  endAt: number,
  switchAt: number | null,
  fleet: number[] | null,
  handle: (msg: AisMessage) => boolean,
): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const ws = new WebSocket(URL);
    const timers: ReturnType<typeof setTimeout>[] = [];
    const finish = (clean: boolean) => {
      if (done) return;
      done = true;
      for (const t of timers) clearTimeout(t);
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
      resolve(clean);
    };
    timers.push(setTimeout(() => finish(true), Math.max(0, endAt - Date.now())));
    ws.addEventListener("open", () => {
      ws.send(
        JSON.stringify({
          APIKey: opts.apiKey,
          BoundingBoxes: opts.boxes,
          FilterMessageTypes: ["PositionReport", "ShipStaticData"],
        }),
      );
      if (switchAt && fleet && switchAt > Date.now()) {
        timers.push(
          setTimeout(() => {
            if (done || ws.readyState !== WebSocket.OPEN) return;
            ws.send(
              JSON.stringify({
                APIKey: opts.apiKey,
                BoundingBoxes: [
                  [
                    [-90, -180],
                    [90, 180],
                  ],
                ],
                FiltersShipMMSI: fleet.map(String),
                FilterMessageTypes: ["PositionReport", "ShipStaticData"],
              }),
            );
          }, switchAt - Date.now()),
        );
      }
    });
    ws.addEventListener("message", async (ev: MessageEvent) => {
      if (done) return;
      try {
        const data = ev.data as unknown;
        const text =
          typeof data === "string"
            ? data
            : data instanceof Blob
              ? await data.text()
              : new TextDecoder().decode(data as ArrayBuffer);
        if (handle(parseAisMessage(JSON.parse(text) as RawEnvelope))) finish(true);
      } catch (err) {
        opts.logger.debug({ err }, "ais frame parse failed");
      }
    });
    ws.addEventListener("error", () => {
      opts.logger.warn("aisstream socket error");
      finish(false);
    });
    ws.addEventListener("close", () => finish(Date.now() >= endAt - 1_000));
  });
}
