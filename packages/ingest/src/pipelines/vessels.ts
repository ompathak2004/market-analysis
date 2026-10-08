import { chunk, DAY, HOUR, MINUTE } from "@ma/core";
import {
  altdataEvents,
  and,
  chokepointTransits,
  companies,
  eq,
  facilities,
  facilityCompanies,
  gte,
  isNull,
  or,
  sql,
  vesselCalls,
  vesselFleet,
  vesselPositions,
  vessels,
} from "@ma/db";
import { load } from "cheerio";
import {
  cargoDirection,
  deriveCalls,
  deriveTransits,
  flagForMmsi,
  isValidImo,
  matchDestination,
  sizeClassFor,
  type VesselPoint,
  vesselClass,
} from "../altdata/maritime.js";
import type { IngestContext } from "../context.js";
import { FACILITY_SEEDS } from "../data/facilities.js";
import { CHOKEPOINTS } from "../data/geofences.js";
import type { Box } from "../data/types.js";
import { AIRPORTS, bboxOfCircle, mergeBoxes, pointInBox } from "../geo.js";
import { type AisStatic, collectAis } from "../sources/aisstream.js";
import { recordCoverage } from "./aircraft.js";

const SEA_CURSOR = "altdata:sea:derive_from";
export const FLEET_PARSER_VERSION = 1;

interface Deadline {
  deadline?: number;
}

function expired(opts: Deadline, reserveMs = 0): boolean {
  return opts.deadline !== undefined && Date.now() > opts.deadline - reserveMs;
}

export async function seedFacilities(ctx: IngestContext): Promise<Record<string, number>> {
  const symbolRows = await ctx.db
    .select({ id: companies.id, symbol: companies.nseSymbol })
    .from(companies)
    .where(sql`${companies.nseSymbol} is not null`);
  const ids = new Map(symbolRows.map((r) => [r.symbol as string, r.id]));
  let links = 0;
  let skipped = 0;
  for (const f of FACILITY_SEEDS) {
    const [row] = await ctx.db
      .insert(facilities)
      .values({
        slug: f.slug,
        name: f.name,
        kind: f.kind,
        lat: f.lat,
        lon: f.lon,
        radiusKm: f.radiusKm,
        locode: f.locode,
        aliases: f.aliases,
        exclusive: f.exclusive,
        active: f.active,
      })
      .onConflictDoUpdate({
        target: facilities.slug,
        set: {
          name: f.name,
          kind: f.kind,
          lat: f.lat,
          lon: f.lon,
          radiusKm: f.radiusKm,
          locode: f.locode,
          aliases: f.aliases,
          exclusive: f.exclusive,
          active: f.active,
          updatedAt: new Date(),
        },
      })
      .returning({ id: facilities.id });
    if (!row) continue;
    for (const c of f.companies) {
      const companyId = ids.get(c.symbol);
      if (companyId === undefined) {
        skipped++;
        continue;
      }
      const values = {
        facilityId: row.id,
        companyId,
        role: c.role,
        commodityIn: c.commodityIn,
        commodityOut: c.commodityOut,
        note: c.note ?? null,
      };
      await ctx.db
        .insert(facilityCompanies)
        .values(values)
        .onConflictDoUpdate({
          target: [facilityCompanies.facilityId, facilityCompanies.companyId],
          set: {
            role: values.role,
            commodityIn: values.commodityIn,
            commodityOut: values.commodityOut,
            note: values.note,
          },
        });
      links++;
    }
  }
  const hq = await seedHeadquarters(ctx);
  return { facilities: FACILITY_SEEDS.length, links, skippedSymbols: skipped, hq };
}

async function seedHeadquarters(ctx: IngestContext): Promise<number> {
  const rows = await ctx.db.execute<{ id: number; symbol: string; name: string; city: string }>(sql`
    select c.id, c.nse_symbol as symbol, c.name, c.registered_city as city
    from companies c
    join index_constituents ic on ic.company_id = c.id
    join indices i on i.id = ic.index_id and i.code = 'NIFTY100'
    where c.registered_city is not null and c.nse_symbol is not null`);
  let created = 0;
  for (const r of rows) {
    const city = r.city.toLowerCase();
    const airport =
      AIRPORTS.find((a) => a.country === "IN" && a.size !== "S" && a.city.toLowerCase() === city) ??
      AIRPORTS.find((a) => a.country === "IN" && a.city.toLowerCase().includes(city));
    if (!airport) continue;
    const slug = `hq-${r.symbol.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
    const [f] = await ctx.db
      .insert(facilities)
      .values({
        slug,
        name: `${r.name} registered office (${airport.city})`,
        kind: "hq",
        lat: airport.lat,
        lon: airport.lon,
        radiusKm: 25,
        locode: null,
        aliases: [],
        exclusive: false,
        active: true,
      })
      .onConflictDoUpdate({
        target: facilities.slug,
        set: { lat: airport.lat, lon: airport.lon, updatedAt: new Date() },
      })
      .returning({ id: facilities.id });
    if (!f) continue;
    await ctx.db
      .insert(facilityCompanies)
      .values({
        facilityId: f.id,
        companyId: r.id,
        role: "owner",
        commodityIn: [],
        commodityOut: [],
      })
      .onConflictDoNothing();
    created++;
  }
  return created;
}

export interface FacilityRow {
  id: number;
  slug: string;
  name: string;
  kind: string;
  lat: number;
  lon: number;
  radiusKm: number;
  locode: string | null;
  aliases: string[];
  exclusive: boolean;
}

export async function loadWatchedFacilities(ctx: IngestContext): Promise<FacilityRow[]> {
  return ctx.db
    .select({
      id: facilities.id,
      slug: facilities.slug,
      name: facilities.name,
      kind: facilities.kind,
      lat: facilities.lat,
      lon: facilities.lon,
      radiusKm: facilities.radiusKm,
      locode: facilities.locode,
      aliases: facilities.aliases,
      exclusive: facilities.exclusive,
    })
    .from(facilities)
    .where(and(eq(facilities.active, true), sql`${facilities.kind} <> 'hq'`));
}

export interface CoverageZone {
  zone: string;
  box: Box;
}

export function aisZones(watched: readonly FacilityRow[]): { boxes: Box[]; zones: CoverageZone[] } {
  const zones: CoverageZone[] = [
    ...watched.map((f) => ({
      zone: `facility:${f.id}`,
      box: bboxOfCircle(f.lat, f.lon, f.radiusKm + 15),
    })),
    ...CHOKEPOINTS.map((c) => ({ zone: `chokepoint:${c.slug}`, box: c.box })),
  ];
  return { boxes: mergeBoxes(zones.map((z) => z.box)), zones };
}

export interface CollectOptions extends Deadline {
  apiKey: string;
  seconds: number;
  maxMessages?: number;
}

export async function collectVesselPositions(
  ctx: IngestContext,
  opts: CollectOptions,
): Promise<Record<string, number>> {
  const watched = await loadWatchedFacilities(ctx);
  const { boxes, zones } = aisZones(watched);
  const fleetRows = await ctx.db
    .select({ mmsi: vessels.mmsi })
    .from(vessels)
    .where(sql`${vessels.ownerCompanyId} is not null`);
  const result = await collectAis({
    apiKey: opts.apiKey,
    boxes,
    mmsiFilter: fleetRows.map((r) => r.mmsi),
    seconds: opts.seconds,
    maxMessages: opts.maxMessages ?? 20_000,
    deadline: (opts.deadline ?? Date.now() + opts.seconds * 1000 + 30_000) - 20_000,
    logger: ctx.logger,
  });
  const positions = result.positions;
  const lastSeen = new Map<number, Date>();
  for (const p of positions) {
    const prev = lastSeen.get(p.mmsi);
    if (!prev || prev < p.ts) lastSeen.set(p.mmsi, p.ts);
  }
  for (const s of result.statics.values()) {
    const prev = lastSeen.get(s.mmsi);
    if (!prev || prev < s.ts) lastSeen.set(s.mmsi, s.ts);
  }
  const vesselRows = [...lastSeen.entries()].map(([mmsi, ts]) => ({
    mmsi,
    name: result.names.get(mmsi) ?? result.statics.get(mmsi)?.name ?? null,
    flag: flagForMmsi(mmsi),
    firstSeenAt: ts,
    lastSeenAt: ts,
  }));
  for (const batch of chunk(vesselRows, 500)) {
    await ctx.db
      .insert(vessels)
      .values(batch)
      .onConflictDoUpdate({
        target: vessels.mmsi,
        set: {
          lastSeenAt: sql`greatest(${vessels.lastSeenAt}, excluded.last_seen_at)`,
          name: sql`coalesce(${vessels.name}, excluded.name)`,
          flag: sql`coalesce(${vessels.flag}, excluded.flag)`,
        },
      });
  }
  const staticCount = await upsertStatics(ctx, [...result.statics.values()], watched);
  let inserted = 0;
  for (const batch of chunk(positions, 500)) {
    const res = await ctx.db
      .insert(vesselPositions)
      .values(batch)
      .onConflictDoNothing()
      .returning({ mmsi: vesselPositions.mmsi });
    inserted += res.length;
  }
  let windowsWithData = 0;
  for (const z of zones) {
    const inside = positions.filter((p) => pointInBox(p.lat, p.lon, z.box));
    const unique = new Set(inside.map((p) => p.mmsi)).size;
    if (inside.length) windowsWithData++;
    await recordCoverage(ctx, "sea", z.zone, inside.length, unique);
  }
  await linkFleetVessels(ctx);
  return {
    messages: result.stats.messages,
    positions: inserted,
    statics: staticCount,
    vessels: vesselRows.length,
    boxes: boxes.length,
    zones: zones.length,
    windowsWithData,
    reconnects: result.stats.reconnects,
    confirmed: result.stats.confirmed,
    errors: result.stats.errors,
  };
}

async function upsertStatics(
  ctx: IngestContext,
  statics: AisStatic[],
  watched: readonly FacilityRow[],
): Promise<number> {
  const kindById = new Map(watched.map((f) => [f.id, f.kind]));
  for (const s of statics) {
    const destinationFacilityId = matchDestination(s.destination, watched);
    const cls = vesselClass(
      s.shipType,
      s.name,
      s.destination,
      destinationFacilityId !== null ? (kindById.get(destinationFacilityId) ?? null) : null,
    );
    const size = sizeClassFor(cls, s.lengthM);
    await ctx.db
      .update(vessels)
      .set({
        imo: s.imo,
        name: s.name ?? sql`${vessels.name}`,
        callSign: s.callSign,
        shipType: s.shipType,
        class: cls,
        lengthM: s.lengthM,
        beamM: s.beamM,
        draughtM: s.draughtM,
        sizeClass: size.sizeClass,
        dwtEst: size.dwtEst,
        destinationRaw: s.destination,
        destinationFacilityId,
        etaRaw: s.eta,
        staticUpdatedAt: s.ts,
      })
      .where(eq(vessels.mmsi, s.mmsi));
  }
  return statics.length;
}

async function linkFleetVessels(ctx: IngestContext): Promise<number> {
  const rows = await ctx.db.execute<{ mmsi: number }>(sql`
    update vessels v set owner_company_id = f.company_id, owner_source_url = f.source_url,
      dwt = coalesce(v.dwt, f.dwt)
    from vessel_fleet f
    where v.owner_company_id is null
      and (v.imo = f.imo or (v.imo is null and upper(v.name) = upper(f.name)))
    returning v.mmsi`);
  return rows.length;
}

interface VesselMeta {
  mmsi: number;
  name: string | null;
  class: string;
  sizeClass: string | null;
  draughtM: number | null;
  destinationRaw: string | null;
  destinationFacilityId: number | null;
}

interface FacilityOwner {
  facilityId: number;
  companyId: number;
}

export async function deriveVesselActivity(
  ctx: IngestContext,
  opts: Deadline & { now?: Date } = {},
): Promise<Record<string, number>> {
  const now = opts.now ?? new Date();
  const cursorRaw = await ctx.redis.get(SEA_CURSOR);
  const cursor = cursorRaw ? new Date(cursorRaw) : new Date(now.getTime() - 48 * HOUR);
  const recentFrom = new Date(cursor.getTime() - 2 * HOUR);
  const lookback = new Date(now.getTime() - 36 * HOUR);
  const watched = await loadWatchedFacilities(ctx);
  const byId = new Map(watched.map((f) => [f.id, f]));
  const owners = await ctx.db
    .select({
      facilityId: facilityCompanies.facilityId,
      companyId: facilityCompanies.companyId,
      role: facilityCompanies.role,
    })
    .from(facilityCompanies);
  const ownerOf = new Map<number, number>();
  for (const o of owners as Array<FacilityOwner & { role: string }>) {
    if (!ownerOf.has(o.facilityId) || o.role === "owner") ownerOf.set(o.facilityId, o.companyId);
  }

  const candidates = await ctx.db.execute<{ mmsi: number }>(sql`
    select distinct mmsi from vessel_positions where ts >= ${recentFrom.toISOString()}
    union select mmsi from vessel_calls where left_at is null
    union select mmsi from chokepoint_transits where left_at is null`);
  const stats = { vessels: 0, calls: 0, openCalls: 0, transits: 0, loitering: 0, events: 0 };
  const callZones = watched.map((f) => ({
    id: f.id,
    lat: f.lat,
    lon: f.lon,
    radiusKm: f.radiusKm,
  }));
  const transitZones = CHOKEPOINTS.map((c) => ({ slug: c.slug, box: c.box }));

  for (const { mmsi } of candidates) {
    if (expired(opts, 20_000)) break;
    stats.vessels++;
    const meta = (
      await ctx.db
        .select({
          mmsi: vessels.mmsi,
          name: vessels.name,
          class: vessels.class,
          sizeClass: vessels.sizeClass,
          draughtM: vessels.draughtM,
          destinationRaw: vessels.destinationRaw,
          destinationFacilityId: vessels.destinationFacilityId,
        })
        .from(vessels)
        .where(eq(vessels.mmsi, mmsi))
    )[0] as VesselMeta | undefined;
    if (!meta) continue;
    const existingCalls = await ctx.db
      .select()
      .from(vesselCalls)
      .where(
        and(
          eq(vesselCalls.mmsi, mmsi),
          or(isNull(vesselCalls.leftAt), gte(vesselCalls.leftAt, lookback)),
        ),
      );
    const existingTransits = await ctx.db
      .select()
      .from(chokepointTransits)
      .where(
        and(
          eq(chokepointTransits.mmsi, mmsi),
          or(isNull(chokepointTransits.leftAt), gte(chokepointTransits.leftAt, lookback)),
        ),
      );
    const from = new Date(
      Math.min(
        lookback.getTime(),
        ...existingCalls.map((c) => c.enteredAt.getTime()),
        ...existingTransits.map((t) => t.enteredAt.getTime()),
      ),
    );
    const points: VesselPoint[] = await ctx.db
      .select({
        ts: vesselPositions.ts,
        lat: vesselPositions.lat,
        lon: vesselPositions.lon,
        sogKt: vesselPositions.sogKt,
        navStatus: vesselPositions.navStatus,
      })
      .from(vesselPositions)
      .where(and(eq(vesselPositions.mmsi, mmsi), gte(vesselPositions.ts, from)))
      .orderBy(vesselPositions.ts);

    const callKey = (facilityId: number, at: Date) => `${facilityId}:${at.getTime()}`;
    const priorCalls = new Map(existingCalls.map((c) => [callKey(c.facilityId, c.enteredAt), c]));
    const events: Array<typeof altdataEvents.$inferInsert> = [];
    for (const call of deriveCalls(points, callZones, { now })) {
      const prior = priorCalls.get(callKey(call.facilityId, call.enteredAt));
      const draughtIn = prior?.draughtIn ?? meta.draughtM;
      const draughtOut = call.leftAt ? (prior?.draughtOut ?? meta.draughtM) : null;
      const dwellMin = Math.round(
        ((call.leftAt ?? call.lastInsideAt).getTime() - call.enteredAt.getTime()) / MINUTE,
      );
      const values = {
        mmsi,
        facilityId: call.facilityId,
        enteredAt: call.enteredAt,
        leftAt: call.leftAt,
        dwellMin,
        draughtIn,
        draughtOut,
        cargoDirection: call.leftAt ? cargoDirection(draughtIn, draughtOut) : null,
        navStatusMode: call.navStatusMode,
        positions: call.positions,
        endedBy: call.endedBy,
      };
      await ctx.db
        .insert(vesselCalls)
        .values(values)
        .onConflictDoUpdate({
          target: [vesselCalls.mmsi, vesselCalls.facilityId, vesselCalls.enteredAt],
          set: {
            leftAt: values.leftAt,
            dwellMin: values.dwellMin,
            draughtOut: values.draughtOut,
            cargoDirection: values.cargoDirection,
            navStatusMode: values.navStatusMode,
            positions: values.positions,
            endedBy: values.endedBy,
          },
        });
      stats.calls++;
      if (!call.leftAt) stats.openCalls++;
      const fac = byId.get(call.facilityId);
      if (!fac) continue;
      const label = vesselLabel(meta);
      const severity = meta.class === "tanker" && fac.exclusive ? 2 : 1;
      const base = {
        layer: "sea",
        companyId: ownerOf.get(fac.id) ?? null,
        facilityId: fac.id,
        severity,
        detail: {
          mmsi,
          name: meta.name,
          class: meta.class,
          sizeClass: meta.sizeClass,
          facilitySlug: fac.slug,
          dwellMin,
          cargoDirection: values.cargoDirection,
          note: "cargo and purpose inferred from AIS; unverified",
        },
      };
      events.push({
        ...base,
        kind: "sea.arrival",
        occurredAt: call.enteredAt,
        headline: `${label} arrived at ${fac.name}`,
        dedupeKey: `call:${mmsi}:${fac.id}:${call.enteredAt.getTime()}:arrival`,
      });
      if (call.leftAt) {
        events.push({
          ...base,
          kind: "sea.departure",
          occurredAt: call.leftAt,
          headline: `${label} left ${fac.name} after ${formatDuration(dwellMin)}`,
          dedupeKey: `call:${mmsi}:${fac.id}:${call.enteredAt.getTime()}:departure`,
        });
      }
    }

    for (const t of deriveTransits(points, transitZones, { now })) {
      const values = {
        mmsi,
        chokepoint: t.chokepoint,
        enteredAt: t.enteredAt,
        leftAt: t.leftAt,
        loiterMin: t.loiterMin,
        minSogKt: t.minSogKt,
        destinationAtEntry: meta.destinationRaw,
        destinationFacilityId: meta.destinationFacilityId,
        direction: t.direction,
      };
      await ctx.db
        .insert(chokepointTransits)
        .values(values)
        .onConflictDoUpdate({
          target: [
            chokepointTransits.mmsi,
            chokepointTransits.chokepoint,
            chokepointTransits.enteredAt,
          ],
          set: {
            leftAt: values.leftAt,
            loiterMin: values.loiterMin,
            minSogKt: values.minSogKt,
            direction: values.direction,
            destinationAtEntry: sql`coalesce(${chokepointTransits.destinationAtEntry}, excluded.destination_at_entry)`,
            destinationFacilityId: sql`coalesce(${chokepointTransits.destinationFacilityId}, excluded.destination_facility_id)`,
          },
        });
      stats.transits++;
      const dest =
        meta.destinationFacilityId !== null ? byId.get(meta.destinationFacilityId) : undefined;
      if (!dest) continue;
      const cp = CHOKEPOINTS.find((c) => c.slug === t.chokepoint);
      const label = vesselLabel(meta);
      const detail = {
        mmsi,
        name: meta.name,
        class: meta.class,
        sizeClass: meta.sizeClass,
        chokepoint: t.chokepoint,
        loiterMin: t.loiterMin,
        destination: meta.destinationRaw,
        destinationFacilitySlug: dest.slug,
        note: "destination taken from AIS free text; cargo inferred, unverified",
      };
      if (t.loiterMin >= 360) {
        stats.loitering++;
        const critical =
          meta.class === "tanker" && (dest.kind === "refinery" || dest.kind === "spm");
        events.push({
          layer: "sea",
          kind: "sea.loitering",
          companyId: ownerOf.get(dest.id) ?? null,
          facilityId: dest.id,
          occurredAt: t.lastInsideAt,
          headline: `${label} bound for ${dest.name} idle ~${Math.round(t.loiterMin / 60)} h at ${cp?.name ?? t.chokepoint}`,
          detail,
          severity: critical ? 3 : 2,
          dedupeKey: `transit:${mmsi}:${t.chokepoint}:${t.enteredAt.getTime()}:loiter`,
        });
      }
      if (t.leftAt) {
        events.push({
          layer: "sea",
          kind: "sea.transit",
          companyId: ownerOf.get(dest.id) ?? null,
          facilityId: dest.id,
          occurredAt: t.leftAt,
          headline: `${label} bound for ${dest.name} transited ${cp?.name ?? t.chokepoint}`,
          detail,
          severity: 1,
          dedupeKey: `transit:${mmsi}:${t.chokepoint}:${t.enteredAt.getTime()}:transit`,
        });
      }
    }
    if (events.length) {
      const res = await ctx.db
        .insert(altdataEvents)
        .values(events)
        .onConflictDoNothing()
        .returning({ id: altdataEvents.id });
      stats.events += res.length;
    }
  }
  await ctx.redis.set(SEA_CURSOR, now.toISOString());
  return stats;
}

function vesselLabel(v: VesselMeta): string {
  const name = v.name ?? `MMSI ${v.mmsi}`;
  const kind = v.sizeClass ?? (v.class !== "other" ? v.class : null);
  return kind ? `${name} (${kind})` : name;
}

function formatDuration(min: number): string {
  if (min < 120) return `${min} min`;
  return `${Math.round(min / 60)} h`;
}

export interface FleetSource {
  symbol: string;
  url: string;
  type: string | null;
  via: "direct" | "firecrawl";
}

const SCI_FLEET = "https://www.shipindia.com/fleet/present_fleet";

export const FLEET_SOURCES: readonly FleetSource[] = [
  { symbol: "SCI", url: `${SCI_FLEET}/present_fleet`, type: "Crude tanker", via: "direct" },
  { symbol: "SCI", url: `${SCI_FLEET}/present_fleet_vlcc`, type: "VLCC", via: "direct" },
  {
    symbol: "SCI",
    url: `${SCI_FLEET}/present_fleet_product`,
    type: "Product tanker",
    via: "direct",
  },
  { symbol: "SCI", url: `${SCI_FLEET}/present_fleet_gas`, type: "Gas carrier", via: "direct" },
  { symbol: "SCI", url: `${SCI_FLEET}/present_fleet_bulk`, type: "Bulk carrier", via: "direct" },
  { symbol: "SCI", url: `${SCI_FLEET}/present_fleet_liners`, type: "Liner", via: "direct" },
  { symbol: "GESHIP", url: "https://greatship.com/fleet", type: null, via: "firecrawl" },
];

export interface FleetRow {
  imo: number;
  name: string;
  dwt: number | null;
  type: string | null;
}

const TYPE_TEXT = /tanker|bulk|carrier|gas|lpg|lng|container|offshore|rig|vlcc|suezmax|aframax/i;

function toDwt(text: string | undefined): number | null {
  if (!text) return null;
  const n = Number(text.replace(/[,\s]/g, ""));
  return Number.isFinite(n) && n >= 1_000 && n <= 500_000 ? Math.round(n) : null;
}

export function parseFleetPage(content: string, defaultType: string | null = null): FleetRow[] {
  const $ = load(content);
  const out = new Map<number, FleetRow>();
  const cardTables = new Set<unknown>();
  $("table").each((_, table) => {
    const kv = new Map<string, string>();
    $(table)
      .find("tr")
      .each((__, tr) => {
        const cells = $(tr)
          .find("td,th")
          .map((___, td) => $(td).text().replace(/\s+/g, " ").trim())
          .get();
        if (cells.length === 2) kv.set((cells[0] as string).toLowerCase(), cells[1] as string);
      });
    const imoKey = [...kv.keys()].find((k) => k.includes("imo"));
    if (!imoKey) return;
    cardTables.add(table);
    const imo = Number((kv.get(imoKey) ?? "").replace(/\D/g, ""));
    if (!isValidImo(imo)) return;
    const holder = $(table).parent();
    const name = (
      holder.find(".fltname").first().text() || holder.find("h2,h3,h4,h5,strong").first().text()
    )
      .replace(/\s+/g, " ")
      .trim();
    if (!name) return;
    const dwtKey = [...kv.keys()].find((k) => /dead ?weight|dwt/.test(k));
    const typeKey = [...kv.keys()].find((k) => /type/.test(k));
    out.set(imo, {
      imo,
      name: name.toUpperCase(),
      dwt: toDwt(dwtKey ? kv.get(dwtKey) : undefined),
      type: (typeKey ? kv.get(typeKey) : null) ?? defaultType,
    });
  });
  $("tr").each((_, tr) => {
    if (cardTables.has($(tr).closest("table").get(0))) return;
    const cells = $(tr)
      .find("td,th")
      .map((__, td) => $(td).text().replace(/\s+/g, " ").trim())
      .get()
      .filter(Boolean);
    const imoCell = cells.find((c) => /^\D*\d{7}\D*$/.test(c));
    const imo = imoCell ? Number(imoCell.replace(/\D/g, "")) : null;
    if (!imo || !isValidImo(imo) || out.has(imo)) return;
    const name = cells.find(
      (c) => /[A-Za-z]{3,}/.test(c) && !/\d{7}/.test(c) && !TYPE_TEXT.test(c),
    );
    if (!name) return;
    const dwt =
      cells
        .filter((c) => c !== imoCell)
        .map(toDwt)
        .find((n) => n !== null) ?? null;
    const type = cells.find((c) => TYPE_TEXT.test(c)) ?? defaultType;
    out.set(imo, { imo, name: name.toUpperCase(), dwt, type });
  });
  return [...out.values()];
}

export async function syncFleets(
  ctx: IngestContext,
  opts: Deadline & { maxScrapes?: number } = {},
): Promise<Record<string, number>> {
  const stats = { sources: 0, failed: 0, vessels: 0, linked: 0, scrapes: 0 };
  const maxScrapes = opts.maxScrapes ?? 2;
  for (const src of FLEET_SOURCES) {
    if (src.via === "firecrawl" && stats.scrapes >= maxScrapes) continue;
    if (expired(opts, 30_000)) break;
    const company = await ctx.db.query.companies.findFirst({
      where: eq(companies.nseSymbol, src.symbol),
    });
    if (!company) continue;
    stats.sources++;
    try {
      const { doc } = await ctx.docs.fetch(src.url, {
        source: "fleet",
        companyId: company.id,
        maxAgeMs: 6 * DAY,
        via: src.via,
      });
      if (src.via === "firecrawl") stats.scrapes++;
      const rows = parseFleetPage(doc.content, src.type);
      for (const batch of chunk(rows, 200)) {
        await ctx.db
          .insert(vesselFleet)
          .values(
            batch.map((r) => ({
              ...r,
              companyId: company.id,
              sourceUrl: src.url,
              fetchedAt: new Date(),
            })),
          )
          .onConflictDoUpdate({
            target: vesselFleet.imo,
            set: {
              name: sql`excluded.name`,
              dwt: sql`excluded.dwt`,
              type: sql`excluded.type`,
              companyId: company.id,
              sourceUrl: src.url,
              fetchedAt: new Date(),
            },
          });
      }
      await ctx.docs.markParsed(doc.id, FLEET_PARSER_VERSION, rows.length ? "parsed" : "failed");
      stats.vessels += rows.length;
    } catch (err) {
      stats.failed++;
      ctx.logger.warn({ err, url: src.url }, "fleet page fetch failed");
    }
  }
  stats.linked = await linkFleetVessels(ctx);
  return stats;
}

export async function cleanupAltdataPositions(
  ctx: IngestContext,
  opts: Deadline & { batch?: number } = {},
): Promise<Record<string, number>> {
  const batch = opts.batch ?? 50_000;
  const stats = { aircraftPositions: 0, vesselPositions: 0 };
  const targets = [
    { key: "aircraftPositions" as const, table: "aircraft_positions", days: 90 },
    { key: "vesselPositions" as const, table: "vessel_positions", days: 30 },
  ];
  for (const t of targets) {
    for (;;) {
      if (expired(opts, 10_000)) return stats;
      const res = await ctx.db.execute(sql`
        delete from ${sql.identifier(t.table)} where ctid in (
          select ctid from ${sql.identifier(t.table)}
          where ts < now() - (${t.days} * interval '1 day') limit ${batch})`);
      const n = (res as unknown as { count?: number }).count ?? 0;
      stats[t.key] += n;
      if (n < batch) break;
    }
  }
  return stats;
}
