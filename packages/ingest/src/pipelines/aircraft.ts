import { chunk, DAY, HOUR, MINUTE, mapLimit } from "@ma/core";
import {
  aircraftFlights,
  aircraftPositions,
  altdataCoverage,
  altdataEvents,
  and,
  asc,
  companies,
  corporateAircraft,
  corporateAircraftCompanies,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  ne,
  or,
  sql,
} from "@ma/db";
import {
  type DerivedLeg,
  legDedupeKey,
  replayFrom,
  segmentLegs,
  summarizeLeg,
  supersededFlights,
} from "../altdata/legs.js";
import type { IngestContext } from "../context.js";
import {
  AIRCRAFT_OVERRIDES,
  BIZJET_TYPES,
  CHARTER_OWNER,
  OWNER_GROUPS,
} from "../data/corporate-aircraft.js";
import type { SymbolLink } from "../data/types.js";
import { matchCompanies } from "../extract/relationships.js";
import { airportByIcao, nearestAirport } from "../geo.js";
import { AdsbSource, type PositionSample } from "../sources/adsb.js";
import { type AircraftDbRow, downloadAircraftDb, lookupAdsbdb } from "../sources/aircraft-db.js";
import type { OpenSkySource } from "../sources/opensky.js";
import { loadAliasMatcher } from "./relationships.js";

const LAST_KEY = "altdata:air:last";
const TRIED_KEY = "altdata:adsbdb:tried";
const MISMATCH_KEY = "altdata:adsbdb:mismatch";
const DERIVE_CURSOR = "altdata:air:derive_from";
const DERIVE_RESUME = "altdata:air:derive_resume";
const REPLAY_MAX_MS = 48 * HOUR;
const RESUME_TTL_S = 24 * 3600;
const HEX_BATCH = 100;

type Basis = SymbolLink[1];

interface Deadline {
  deadline?: number;
}

function expired(opts: Deadline, reserveMs = 0): boolean {
  return opts.deadline !== undefined && Date.now() > opts.deadline - reserveMs;
}

async function symbolIds(ctx: IngestContext): Promise<Map<string, number>> {
  const rows = await ctx.db
    .select({ id: companies.id, symbol: companies.nseSymbol })
    .from(companies)
    .where(sql`${companies.nseSymbol} is not null`);
  return new Map(rows.map((r) => [r.symbol as string, r.id]));
}

async function replaceLinks(
  ctx: IngestContext,
  aircraftId: number,
  links: ReadonlyArray<{ companyId: number; basis: Basis }>,
): Promise<number> {
  await ctx.db
    .delete(corporateAircraftCompanies)
    .where(eq(corporateAircraftCompanies.aircraftId, aircraftId));
  const unique = [...new Map(links.map((l) => [l.companyId, l])).values()];
  if (!unique.length) return 0;
  await ctx.db
    .insert(corporateAircraftCompanies)
    .values(unique.map((l) => ({ aircraftId, companyId: l.companyId, basis: l.basis })))
    .onConflictDoNothing();
  return unique.length;
}

function resolveLinks(
  links: readonly SymbolLink[],
  ids: Map<string, number>,
): Array<{ companyId: number; basis: Basis }> {
  const out: Array<{ companyId: number; basis: Basis }> = [];
  for (const [symbol, basis] of links) {
    const companyId = ids.get(symbol);
    if (companyId !== undefined) out.push({ companyId, basis });
  }
  return out;
}

export interface RegistryOptions extends Deadline {
  adsbdbLimit?: number;
  force?: boolean;
}

export async function seedAircraftRegistry(
  ctx: IngestContext,
  opts: RegistryOptions = {},
): Promise<Record<string, number>> {
  const stats: Record<string, number> = {
    csvRows: 0,
    candidates: 0,
    inserted: 0,
    adsbdbCalls: 0,
    ownersResolved: 0,
    hexMismatch: 0,
    linked: 0,
    charter: 0,
    overrides: 0,
    active: 0,
    links: 0,
  };
  const [{ n: existing } = { n: 0 }] = await ctx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(corporateAircraft);
  const csv = await downloadAircraftDb(ctx.http, ctx.redis, {
    force: Boolean(opts.force) || existing === 0,
  });
  const overrideRegs = new Set(AIRCRAFT_OVERRIDES.map((o) => o.registration));
  if (csv) {
    stats.csvRows = csv.length;
    const candidates = csv.filter(
      (r) =>
        !r.military &&
        ((r.icaoType !== null && BIZJET_TYPES.has(r.icaoType)) || overrideRegs.has(r.registration)),
    );
    stats.candidates = candidates.length;
    for (const batch of chunk(candidates, 200)) {
      const res = await ctx.db
        .insert(corporateAircraft)
        .values(
          batch.map((r) => ({
            registration: r.registration,
            icaoHex: r.hex,
            icaoType: r.icaoType,
            model: r.model,
            tier: "inferred" as const,
            confidence: 0.2,
            privacyFlagged: r.privacy,
            active: false,
          })),
        )
        .onConflictDoNothing()
        .returning({ id: corporateAircraft.id });
      stats.inserted = (stats.inserted ?? 0) + res.length;
      await updateRegistryFacts(ctx, batch);
    }
  }

  await resolveOwners(ctx, opts, stats);
  if (expired(opts, 20_000)) return stats;

  const ids = await symbolIds(ctx);
  const matcher = await loadAliasMatcher(ctx);
  const mismatched = new Set(await ctx.redis.smembers(MISMATCH_KEY));
  const rows = await ctx.db
    .select()
    .from(corporateAircraft)
    .where(
      and(ne(corporateAircraft.tier, "manual"), sql`${corporateAircraft.ownerName} is not null`),
    );
  for (const row of rows) {
    const owner = row.ownerName as string;
    const group = OWNER_GROUPS.find((g) => g.pattern.test(owner));
    let links: Array<{ companyId: number; basis: Basis }> = [];
    let groupName: string | null = null;
    if (group) {
      links = resolveLinks(group.links, ids);
      groupName = group.groupName;
    } else if (CHARTER_OWNER.test(owner)) {
      stats.charter = (stats.charter ?? 0) + 1;
    } else {
      const hits = [...matchCompanies(owner, matcher)];
      links = hits.map((h) => ({ companyId: h.companyId, basis: "owner" as const }));
      groupName = hits[0]?.matched ?? null;
    }
    const mismatch = mismatched.has(row.registration);
    const linked = links.length > 0;
    await ctx.db
      .update(corporateAircraft)
      .set({
        tier: linked ? "registry" : "inferred",
        confidence: linked ? (mismatch ? 0.6 : 0.9) : mismatch ? 0.1 : 0.2,
        active: linked,
        groupName,
        sourceUrl: linked
          ? `https://api.adsbdb.com/v0/aircraft/${row.registration}`
          : row.sourceUrl,
        updatedAt: new Date(),
      })
      .where(eq(corporateAircraft.id, row.id));
    stats.links = (stats.links ?? 0) + (await replaceLinks(ctx, row.id, links));
    if (linked) stats.linked = (stats.linked ?? 0) + 1;
  }

  stats.overrides = await applyOverrides(ctx, ids, csv);
  const [counts] = await ctx.db.execute<{ active: number; links: number }>(sql`
    select (select count(*)::int from corporate_aircraft where active) as active,
           (select count(*)::int from corporate_aircraft_companies) as links`);
  stats.active = counts?.active ?? 0;
  stats.links = counts?.links ?? 0;
  return stats;
}

async function updateRegistryFacts(ctx: IngestContext, rows: AircraftDbRow[]): Promise<void> {
  if (!rows.length) return;
  const payload = JSON.stringify(
    rows.map((r) => ({ reg: r.registration, type: r.icaoType, model: r.model, p: r.privacy })),
  );
  await ctx.db.execute(sql`
    update corporate_aircraft a set
      icao_type = coalesce(a.icao_type, x.type),
      model = coalesce(a.model, x.model),
      privacy_flagged = x.p,
      updated_at = now()
    from jsonb_to_recordset(${payload}::jsonb) as x(reg text, type text, model text, p boolean)
    where a.registration = x.reg and (a.privacy_flagged is distinct from x.p or a.icao_type is null)`);
}

async function resolveOwners(
  ctx: IngestContext,
  opts: RegistryOptions,
  stats: Record<string, number>,
): Promise<void> {
  const limit = opts.adsbdbLimit ?? 40;
  const pending = await ctx.db
    .select({
      id: corporateAircraft.id,
      reg: corporateAircraft.registration,
      hex: corporateAircraft.icaoHex,
    })
    .from(corporateAircraft)
    .where(and(isNull(corporateAircraft.ownerName), ne(corporateAircraft.tier, "manual")))
    .orderBy(corporateAircraft.id);
  const tried = await ctx.redis.hgetall(TRIED_KEY);
  const cutoff = Date.now() - 14 * DAY;
  const todo = pending.filter((p) => Number(tried[p.reg] ?? 0) < cutoff).slice(0, limit);
  for (const row of todo) {
    if (expired(opts, 60_000)) break;
    stats.adsbdbCalls = (stats.adsbdbCalls ?? 0) + 1;
    let hit = await lookupAdsbdb(ctx.http, row.reg).catch(() => null);
    if (!hit) {
      stats.adsbdbCalls = (stats.adsbdbCalls ?? 0) + 1;
      hit = await lookupAdsbdb(ctx.http, row.hex).catch(() => null);
    }
    await ctx.redis.hset(TRIED_KEY, row.reg, String(Date.now()));
    if (!hit?.owner) continue;
    const mismatch = hit.modeS !== null && hit.modeS !== row.hex;
    if (mismatch) {
      stats.hexMismatch = (stats.hexMismatch ?? 0) + 1;
      await ctx.redis.sadd(MISMATCH_KEY, row.reg);
      ctx.logger.warn({ reg: row.reg, ours: row.hex, adsbdb: hit.modeS }, "adsbdb hex mismatch");
    }
    await ctx.db
      .update(corporateAircraft)
      .set({
        ownerName: hit.owner,
        confidence: mismatch ? 0.1 : 0.2,
        updatedAt: new Date(),
      })
      .where(eq(corporateAircraft.id, row.id));
    stats.ownersResolved = (stats.ownersResolved ?? 0) + 1;
  }
  await ctx.redis.expire(TRIED_KEY, 60 * 86_400);
}

async function applyOverrides(
  ctx: IngestContext,
  ids: Map<string, number>,
  csv: AircraftDbRow[] | null,
): Promise<number> {
  let applied = 0;
  const csvByReg = new Map((csv ?? []).map((r) => [r.registration, r]));
  for (const o of AIRCRAFT_OVERRIDES) {
    let row = await ctx.db.query.corporateAircraft.findFirst({
      where: eq(corporateAircraft.registration, o.registration),
    });
    if (!row) {
      const src = csvByReg.get(o.registration);
      const fallback = src ? null : await lookupAdsbdb(ctx.http, o.registration).catch(() => null);
      const hex = src?.hex ?? fallback?.modeS ?? null;
      if (!hex) {
        ctx.logger.warn({ reg: o.registration }, "override aircraft not found in any registry");
        continue;
      }
      const [inserted] = await ctx.db
        .insert(corporateAircraft)
        .values({
          registration: o.registration,
          icaoHex: hex,
          icaoType: src?.icaoType ?? fallback?.icaoType ?? null,
          model: src?.model ?? fallback?.model ?? null,
          tier: "manual",
          confidence: 1,
          privacyFlagged: src?.privacy ?? false,
          active: false,
        })
        .onConflictDoNothing()
        .returning();
      row = inserted;
      if (!row) continue;
    }
    const now = new Date();
    if (o.action === "link") {
      await ctx.db
        .update(corporateAircraft)
        .set({
          tier: "manual",
          confidence: 1,
          active: true,
          groupName: o.groupName ?? row.groupName,
          ownerName: o.ownerName ?? row.ownerName,
          linkedPerson: o.linkedPerson ?? row.linkedPerson,
          linkedRole: o.linkedRole ?? row.linkedRole,
          sourceUrl: o.sourceUrl,
          verifiedAt: now,
          updatedAt: now,
        })
        .where(eq(corporateAircraft.id, row.id));
      await replaceLinks(ctx, row.id, resolveLinks(o.links ?? [], ids));
    } else {
      await ctx.db
        .update(corporateAircraft)
        .set({
          tier: "manual",
          confidence: 1,
          active: false,
          sourceUrl: o.sourceUrl,
          updatedAt: now,
        })
        .where(eq(corporateAircraft.id, row.id));
      if (o.action === "unlink") await replaceLinks(ctx, row.id, []);
    }
    applied++;
  }
  return applied;
}

type ActiveAircraft = {
  id: number;
  hex: string;
  registration: string;
  icaoType: string | null;
  groupName: string | null;
  companyId: number | null;
};

async function loadActiveAircraft(ctx: IngestContext): Promise<ActiveAircraft[]> {
  return ctx.db.execute<ActiveAircraft>(sql`
    select a.id, a.icao_hex as hex, a.registration, a.icao_type as "icaoType", a.group_name as "groupName",
      (select l.company_id from corporate_aircraft_companies l where l.aircraft_id = a.id
        order by case l.basis when 'owner' then 0 when 'subsidiary' then 1 else 2 end, l.company_id limit 1) as "companyId"
    from corporate_aircraft a where a.active`);
}

function placeLabel(
  lat: number,
  lon: number,
): { icao: string | null; city: string | null; country: string | null } {
  const near = nearestAirport(lat, lon, 40);
  return near
    ? { icao: near.airport.icao, city: near.airport.city, country: near.airport.country }
    : { icao: null, city: null, country: null };
}

function aircraftLabel(a: ActiveAircraft): string {
  return a.groupName ? `${a.registration} (${a.groupName} group aircraft)` : a.registration;
}

export async function sampleAircraftPositions(
  ctx: IngestContext,
  opts: Deadline = {},
): Promise<Record<string, number>> {
  const fleet = await loadActiveAircraft(ctx);
  const byHex = new Map(fleet.map((a) => [a.hex, a]));
  const adsb = new AdsbSource(ctx.http);
  let requests = 0;
  let failures = 0;
  const jobs: Array<() => Promise<PositionSample[]>> = chunk(
    fleet.map((a) => a.hex),
    HEX_BATCH,
  ).map((hexes) => () => adsb.byHex(hexes));
  const results = await mapLimit(jobs, 1, async (fn) => {
    if (expired(opts, 10_000)) return [];
    requests++;
    try {
      return await fn();
    } catch (err) {
      failures++;
      ctx.logger.warn({ err }, "adsb.lol request failed");
      return [];
    }
  });
  const latest = new Map<string, PositionSample>();
  for (const s of results.flat()) {
    if (!byHex.has(s.hex)) continue;
    const prev = latest.get(s.hex);
    if (!prev || prev.ts < s.ts) latest.set(s.hex, s);
  }
  const samples = [...latest.values()];
  let inserted = 0;
  if (samples.length) {
    const res = await ctx.db
      .insert(aircraftPositions)
      .values(
        samples.map((s) => ({
          hex: s.hex,
          ts: s.ts,
          lat: s.lat,
          lon: s.lon,
          altFt: s.onGround ? null : s.altFt,
          gsKt: s.gsKt,
          track: s.track,
          onGround: s.onGround,
          squawk: s.squawk,
          source: "adsb_lol",
        })),
      )
      .onConflictDoNothing()
      .returning({ hex: aircraftPositions.hex });
    inserted = res.length;
    const payload = JSON.stringify(samples.map((s) => ({ hex: s.hex, ts: s.ts.toISOString() })));
    await ctx.db.execute(sql`
      update corporate_aircraft a set
        last_seen_at = greatest(a.last_seen_at, x.ts),
        first_seen_at = coalesce(a.first_seen_at, x.ts),
        updated_at = now()
      from jsonb_to_recordset(${payload}::jsonb) as x(hex text, ts timestamptz)
      where a.icao_hex = x.hex`);
  }
  const events = await emitAirEvents(ctx, samples, byHex);
  await recordCoverage(ctx, "air", "air:registry", samples.length, latest.size);
  return {
    aircraft: fleet.length,
    requests,
    failures,
    seen: samples.length,
    positions: inserted,
    events,
  };
}

async function emitAirEvents(
  ctx: IngestContext,
  samples: PositionSample[],
  byHex: Map<string, ActiveAircraft>,
): Promise<number> {
  if (!samples.length) return 0;
  const prev = await ctx.redis.hgetall(LAST_KEY);
  const rows: Array<typeof altdataEvents.$inferInsert> = [];
  for (const s of samples) {
    const a = byHex.get(s.hex);
    if (!a) continue;
    const before = prev[s.hex]
      ? (JSON.parse(prev[s.hex] as string) as { ts: number; g: boolean })
      : null;
    let kind: "air.sighted" | "air.takeoff" | "air.landed" | null = null;
    if (!before || s.ts.getTime() - before.ts >= 6 * HOUR) kind = "air.sighted";
    else if (before.g && !s.onGround) kind = "air.takeoff";
    else if (!before.g && s.onGround) kind = "air.landed";
    if (!kind) continue;
    const place = placeLabel(s.lat, s.lon);
    const where = place.icao ? `${place.city ?? place.icao} (${place.icao})` : "en route";
    const verb =
      kind === "air.takeoff" ? "took off near" : kind === "air.landed" ? "landed at" : "seen";
    const headline =
      kind === "air.sighted"
        ? `${aircraftLabel(a)} seen ${s.onGround ? "on the ground at" : "airborne near"} ${where}`
        : `${aircraftLabel(a)} ${verb} ${where}`;
    rows.push({
      layer: "air",
      kind,
      companyId: a.companyId,
      facilityId: null,
      occurredAt: s.ts,
      headline,
      detail: {
        registration: a.registration,
        hex: s.hex,
        groupName: a.groupName,
        icao: place.icao,
        city: place.city,
        country: place.country,
        lat: s.lat,
        lon: s.lon,
        altFt: s.altFt,
        onGround: s.onGround,
      },
      severity: 1,
      dedupeKey: `${s.hex}:${kind}:${Math.floor(s.ts.getTime() / (30 * MINUTE))}`,
    });
  }
  const next: Record<string, string> = {};
  for (const s of samples) next[s.hex] = JSON.stringify({ ts: s.ts.getTime(), g: s.onGround });
  await ctx.redis.hset(LAST_KEY, next);
  await ctx.redis.expire(LAST_KEY, 86_400);
  if (!rows.length) return 0;
  const res = await ctx.db
    .insert(altdataEvents)
    .values(rows)
    .onConflictDoNothing()
    .returning({ id: altdataEvents.id });
  return res.length;
}

export async function recordCoverage(
  ctx: IngestContext,
  layer: string,
  zone: string,
  messages: number,
  uniqueIds: number,
  day = new Date(),
): Promise<void> {
  await ctx.db
    .insert(altdataCoverage)
    .values({
      layer,
      zone,
      day: day.toISOString().slice(0, 10),
      windows: 1,
      windowsWithData: messages > 0 ? 1 : 0,
      messages,
      uniqueIds,
    })
    .onConflictDoUpdate({
      target: [altdataCoverage.layer, altdataCoverage.zone, altdataCoverage.day],
      set: {
        windows: sql`${altdataCoverage.windows} + 1`,
        windowsWithData: sql`${altdataCoverage.windowsWithData} + excluded.windows_with_data`,
        messages: sql`${altdataCoverage.messages} + excluded.messages`,
        uniqueIds: sql`greatest(${altdataCoverage.uniqueIds}, excluded.unique_ids)`,
      },
    });
}

export interface DeriveFlightsOptions extends Deadline {
  opensky?: OpenSkySource | null;
  openskyLimit?: number;
  now?: Date;
}

export async function deriveAircraftFlights(
  ctx: IngestContext,
  opts: DeriveFlightsOptions = {},
): Promise<Record<string, number>> {
  const now = opts.now ?? new Date();
  const [cursorRaw, resumeRaw] = await Promise.all([
    ctx.redis.get(DERIVE_CURSOR),
    ctx.redis.get(DERIVE_RESUME),
  ]);
  const resume = parseResume(resumeRaw);
  const cursor = cursorRaw ? new Date(cursorRaw) : new Date(now.getTime() - REPLAY_MAX_MS);
  const seenFrom = new Date(cursor.getTime() - 3 * HOUR);
  const fleet = await ctx.db
    .select({ id: corporateAircraft.id, hex: corporateAircraft.icaoHex })
    .from(corporateAircraft)
    .where(
      and(
        gt(corporateAircraft.id, resume?.afterId ?? 0),
        or(
          gte(corporateAircraft.lastSeenAt, seenFrom),
          sql`exists (select 1 from ${aircraftFlights} f where f.aircraft_id = ${corporateAircraft.id}
            and f.arrived_at is null and f.source in ('sampled', 'merged'))`,
        ),
      ),
    )
    .orderBy(asc(corporateAircraft.id));
  const stats = {
    aircraft: fleet.length,
    processed: 0,
    resumed: resume ? 1 : 0,
    samples: 0,
    legs: 0,
    open: 0,
    full: 0,
    removed: 0,
    opensky: 0,
  };
  let lastId = resume?.afterId ?? 0;
  for (const a of fleet) {
    if (expired(opts, 30_000)) break;
    const stored = await ctx.db
      .select({
        id: aircraftFlights.id,
        dedupeKey: aircraftFlights.dedupeKey,
        departedAt: aircraftFlights.departedAt,
        arrivedAt: aircraftFlights.arrivedAt,
      })
      .from(aircraftFlights)
      .where(
        and(
          eq(aircraftFlights.aircraftId, a.id),
          inArray(aircraftFlights.source, ["sampled", "merged"]),
          sql`coalesce(${aircraftFlights.arrivedAt}, ${aircraftFlights.departedAt}) >= ${new Date(now.getTime() - REPLAY_MAX_MS).toISOString()}`,
        ),
      );
    const from = replayFrom(stored, now, REPLAY_MAX_MS);
    const rows = await ctx.db
      .select()
      .from(aircraftPositions)
      .where(and(eq(aircraftPositions.hex, a.hex), gte(aircraftPositions.ts, from)))
      .orderBy(aircraftPositions.ts);
    stats.samples += rows.length;
    const derived: DerivedLeg[] = [];
    for (const leg of segmentLegs(rows, { now })) {
      const sum = summarizeLeg(leg);
      const key = legDedupeKey(a.hex, sum.firstTs);
      derived.push({ key, departedAt: sum.departedAt, endAt: sum.arrivedAt ?? sum.lastTs });
      const values = {
        aircraftId: a.id,
        hex: a.hex,
        departedAt: sum.departedAt,
        arrivedAt: sum.arrivedAt,
        durationMin: sum.durationMin,
        depIcao: sum.dep?.icao ?? null,
        depCity: sum.dep?.city ?? null,
        depCountry: sum.dep?.country ?? null,
        arrIcao: sum.arr?.icao ?? null,
        arrCity: sum.arr?.city ?? null,
        arrCountry: sum.arr?.country ?? null,
        completeness: sum.completeness,
        source: "sampled",
        samples: sum.samples,
        maxAltFt: sum.maxAltFt,
        dedupeKey: key,
      };
      await ctx.db
        .insert(aircraftFlights)
        .values(values)
        .onConflictDoUpdate({
          target: aircraftFlights.dedupeKey,
          set: {
            departedAt: values.departedAt,
            arrivedAt: values.arrivedAt,
            durationMin: values.durationMin,
            depIcao: sql`coalesce(excluded.dep_icao, ${aircraftFlights.depIcao})`,
            depCity: sql`coalesce(excluded.dep_city, ${aircraftFlights.depCity})`,
            depCountry: sql`coalesce(excluded.dep_country, ${aircraftFlights.depCountry})`,
            arrIcao: sql`coalesce(excluded.arr_icao, ${aircraftFlights.arrIcao})`,
            arrCity: sql`coalesce(excluded.arr_city, ${aircraftFlights.arrCity})`,
            arrCountry: sql`coalesce(excluded.arr_country, ${aircraftFlights.arrCountry})`,
            completeness: values.completeness,
            samples: values.samples,
            maxAltFt: values.maxAltFt,
            updatedAt: new Date(),
          },
        });
      stats.legs++;
      if (leg.open) stats.open++;
      if (sum.completeness === "full") stats.full++;
    }
    const superseded = supersededFlights(stored, derived, from);
    if (superseded.length) {
      await ctx.db.delete(aircraftFlights).where(inArray(aircraftFlights.id, superseded));
      stats.removed += superseded.length;
    }
    lastId = a.id;
    stats.processed++;
  }
  if (stats.processed === fleet.length) {
    await ctx.redis.set(DERIVE_CURSOR, (resume?.passStart ?? now).toISOString());
    await ctx.redis.del(DERIVE_RESUME);
  } else {
    const next: DeriveResume = { passStart: resume?.passStart ?? now, afterId: lastId };
    await ctx.redis.set(DERIVE_RESUME, JSON.stringify(next), "EX", RESUME_TTL_S);
  }
  if (opts.opensky && (await opts.opensky.available())) {
    stats.opensky = await mergeOpenSky(ctx, opts.opensky, fleet, opts);
  }
  await updateHomeAirports(ctx);
  return stats;
}

interface DeriveResume {
  passStart: Date;
  afterId: number;
}

function parseResume(raw: string | null): DeriveResume | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { passStart?: string; afterId?: number };
    const passStart = v.passStart ? new Date(v.passStart) : null;
    if (!passStart || Number.isNaN(passStart.getTime()) || !Number.isInteger(v.afterId))
      return null;
    return { passStart, afterId: v.afterId as number };
  } catch {
    return null;
  }
}

async function mergeOpenSky(
  ctx: IngestContext,
  opensky: OpenSkySource,
  fleet: Array<{ id: number; hex: string }>,
  opts: DeriveFlightsOptions,
): Promise<number> {
  const limit = opts.openskyLimit ?? 40;
  const end = opts.now ?? new Date();
  const begin = new Date(end.getTime() - 48 * HOUR);
  let merged = 0;
  for (const a of fleet.slice(0, limit)) {
    if (expired(opts, 30_000)) break;
    let flights: Awaited<ReturnType<OpenSkySource["flightsForAircraft"]>>;
    try {
      flights = await opensky.flightsForAircraft(a.hex, begin, end);
    } catch (err) {
      await opensky.disable(err instanceof Error ? err.message : String(err));
      break;
    }
    for (const f of flights) {
      const dep = airportByIcao(f.depIcao);
      const arr = airportByIcao(f.arrIcao);
      const overlap = await ctx.db
        .select({ id: aircraftFlights.id })
        .from(aircraftFlights)
        .where(
          and(
            eq(aircraftFlights.aircraftId, a.id),
            sql`${aircraftFlights.departedAt} <= ${new Date(f.lastSeen.getTime() + 45 * MINUTE).toISOString()}`,
            sql`coalesce(${aircraftFlights.arrivedAt}, now()) >= ${new Date(f.firstSeen.getTime() - 45 * MINUTE).toISOString()}`,
          ),
        )
        .limit(1);
      const hit = overlap[0];
      if (hit) {
        await ctx.db
          .update(aircraftFlights)
          .set({
            depIcao: sql`coalesce(${aircraftFlights.depIcao}, ${dep?.icao ?? null})`,
            depCity: sql`coalesce(${aircraftFlights.depCity}, ${dep?.city ?? null})`,
            depCountry: sql`coalesce(${aircraftFlights.depCountry}, ${dep?.country ?? null})`,
            arrIcao: sql`coalesce(${aircraftFlights.arrIcao}, ${arr?.icao ?? null})`,
            arrCity: sql`coalesce(${aircraftFlights.arrCity}, ${arr?.city ?? null})`,
            arrCountry: sql`coalesce(${aircraftFlights.arrCountry}, ${arr?.country ?? null})`,
            completeness: sql`case when coalesce(${aircraftFlights.depIcao}, ${dep?.icao ?? null}) is not null and coalesce(${aircraftFlights.arrIcao}, ${arr?.icao ?? null}) is not null then 'full'::flight_completeness else ${aircraftFlights.completeness} end`,
            source: "merged",
            updatedAt: new Date(),
          })
          .where(eq(aircraftFlights.id, hit.id));
      } else {
        await ctx.db
          .insert(aircraftFlights)
          .values({
            aircraftId: a.id,
            hex: a.hex,
            departedAt: f.firstSeen,
            arrivedAt: f.lastSeen,
            durationMin: Math.round((f.lastSeen.getTime() - f.firstSeen.getTime()) / MINUTE),
            depIcao: dep?.icao ?? null,
            depCity: dep?.city ?? null,
            depCountry: dep?.country ?? null,
            arrIcao: arr?.icao ?? null,
            arrCity: arr?.city ?? null,
            arrCountry: arr?.country ?? null,
            completeness:
              dep && arr ? "full" : dep ? "departure_only" : arr ? "arrival_only" : "enroute",
            source: "opensky",
            samples: 0,
            maxAltFt: null,
            dedupeKey: `${legDedupeKey(a.hex, f.firstSeen)}:os`,
          })
          .onConflictDoNothing();
      }
      merged++;
    }
  }
  return merged;
}

async function updateHomeAirports(ctx: IngestContext): Promise<void> {
  await ctx.db.execute(sql`
    update corporate_aircraft a set home_icao = h.icao, updated_at = now()
    from (
      select distinct on (aircraft_id) aircraft_id, arr_icao as icao
      from aircraft_flights
      where arr_icao is not null and arrived_at >= now() - interval '90 days'
      group by aircraft_id, arr_icao
      order by aircraft_id, count(*) desc, max(arrived_at) desc
    ) h
    where h.aircraft_id = a.id and a.home_icao is distinct from h.icao`);
}
