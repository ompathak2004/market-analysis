import { sql } from "@ma/db";
import { airportByIcao, CHOKEPOINTS } from "@ma/ingest";
import {
  type AltdataSignalInputs,
  CHOKEPOINT_LOITER_MIN,
  cargoValueEstimate,
  coverageFactor,
  LOGISTICS_MIN_COVERAGE,
  type Prices,
} from "@ma/intel";
import type { AppContext } from "../context";
import { findCompany } from "./core";

const MINUTE = 60_000;
const PRICE_TTL_MS = 15 * MINUTE;
const MAP_RADIUS_KM = 60;

type SQL = ReturnType<typeof sql>;

function isoz(column: string): SQL {
  return sql.raw(`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`);
}

export type AltdataSignalView = {
  kind: string;
  asOf: string;
  value: number;
  inputs: AltdataSignalInputs;
};

export type AirportRef = {
  icao: string;
  iata: string | null;
  city: string | null;
  country: string | null;
};

export type TravelAircraftView = {
  registration: string;
  icaoType: string | null;
  model: string | null;
  groupName: string | null;
  linkedPerson: string | null;
  linkedRole: string | null;
  tier: string;
  confidence: number;
  privacyFlagged: boolean;
  lastSeenAt: string | null;
  homeIcao: string | null;
};

export type TravelLegView = {
  id: number;
  registration: string;
  departedAt: string | null;
  arrivedAt: string | null;
  durationMin: number | null;
  dep: AirportRef | null;
  arr: AirportRef | null;
  completeness: string;
  source: string;
};

export type TravelCoverageView = {
  aircraftActive: number;
  aircraftSeen30d: number;
  legsFull30d: number;
  legs30d: number;
  lastSampleAt: string | null;
};

export type CompanyTravel = {
  aircraft: TravelAircraftView[];
  legs: TravelLegView[];
  weeklyLegCounts: Array<{ weekStart: string; count: number }>;
  signals: AltdataSignalView[];
  coverage: TravelCoverageView;
  sources: string[];
  registryVerifiedAt: string | null;
};

export type LogisticsActiveVessel = {
  mmsi: number;
  name: string | null;
  class: string;
  sizeClass: string | null;
  sinceAt: string;
  navStatus: number | null;
};

export type LogisticsFacilityView = {
  id: number;
  slug: string;
  name: string;
  kind: string;
  lat: number;
  lon: number;
  radiusKm: number;
  role: string;
  commodityIn: string[];
  commodityOut: string[];
  exclusive: boolean;
  verifiedAt: string | null;
  coverage7d: number;
  arrivalsWeekly: Array<{ weekStart: string; count: number }>;
  activeVessels: LogisticsActiveVessel[];
};

export type LogisticsCallView = {
  id: number;
  facilitySlug: string;
  mmsi: number;
  name: string | null;
  class: string;
  sizeClass: string | null;
  enteredAt: string;
  leftAt: string | null;
  dwellMin: number | null;
  cargoDirection: string | null;
  cargoProxy: { commodity: string; bbl: number | null };
};

export type ChokepointWatchView = {
  mmsi: number;
  name: string | null;
  class: string;
  sizeClass: string | null;
  chokepoint: string;
  loiterMin: number;
  destination: string | null;
  destinationFacilitySlug: string | null;
  estValueCr: number | null;
  loitering: boolean;
  lastPositionAt: string | null;
};

export type ChokepointCoverageView = {
  slug: string;
  name: string;
  factor7d: number;
  covered: boolean;
};

export type FleetVesselView = {
  imo: number;
  name: string;
  dwt: number | null;
  type: string | null;
  mmsi: number | null;
  class: string | null;
  lastSeenAt: string | null;
  sogKt: number | null;
};

export type MapPosition = {
  mmsi: number;
  lat: number;
  lon: number;
  cogDeg: number | null;
  class: string;
  ts: string;
};

export type CompanyLogistics = {
  facilities: LogisticsFacilityView[];
  calls: LogisticsCallView[];
  chokepointWatch: ChokepointWatchView[];
  fleet: { size: number; seen7d: number; vessels: FleetVesselView[] } | null;
  signals: AltdataSignalView[];
  coverage: {
    factor7d: number;
    lastSampleAt: string | null;
    windows24h: number;
    windowsWithData24h: number;
    chokepoints: ChokepointCoverageView[];
  };
  positionsForMap: MapPosition[];
  sources: string[];
};

export type AltdataActivityItem = {
  id: number;
  layer: string;
  kind: string;
  occurredAt: string;
  severity: number;
  headline: string;
  symbol: string | null;
  companyName: string | null;
  facilitySlug: string | null;
  detail: Record<string, unknown>;
};

export async function altdataPrices(ctx: AppContext): Promise<Prices | null> {
  return ctx.cache.getOrLoad(
    "altdata:prices",
    async () => {
      const [brent, usdinr] = await Promise.all([
        ctx.yahoo.quote("BZ=F").catch(() => null),
        ctx.yahoo.quote("INR=X").catch(() => null),
      ]);
      if (!brent?.price || !usdinr?.price) return null;
      return { brent: brent.price, usdinr: usdinr.price };
    },
    { ttlMs: PRICE_TTL_MS },
  );
}

async function latestKindSignals(
  ctx: AppContext,
  companyId: number,
  prefix: string,
): Promise<AltdataSignalView[]> {
  const rows = await ctx.db.execute<{
    kind: string;
    asOf: string;
    value: number;
    inputs: AltdataSignalInputs;
  }>(sql`
    select distinct on (kind) kind, as_of::text as "asOf", value, inputs from signals
    where company_id = ${companyId} and kind like ${`${prefix}%`}
      and as_of = (select max(as_of) from signals where company_id = ${companyId} and kind like ${`${prefix}%`})
    order by kind, model_version desc`);
  return rows.map((r) => ({ ...r }));
}

function airportRef(
  icao: string | null,
  city: string | null,
  country: string | null,
): AirportRef | null {
  if (!icao) return null;
  const a = airportByIcao(icao);
  return {
    icao,
    iata: a?.iata ?? null,
    city: city ?? a?.city ?? null,
    country: country ?? a?.country ?? null,
  };
}

export async function companyTravel(
  ctx: AppContext,
  symbol: string,
): Promise<CompanyTravel | null> {
  const company = await findCompany(ctx, symbol);
  return ctx.api.getOrLoad(
    `travel:${company.nseSymbol}`,
    async () => {
      const aircraft = await ctx.db.execute<
        TravelAircraftView & { id: number; verifiedAt: string | null }
      >(sql`
        select distinct a.id, a.registration, a.icao_type as "icaoType", a.model, a.group_name as "groupName",
          a.linked_person as "linkedPerson", a.linked_role as "linkedRole", a.tier::text as tier,
          a.confidence, a.privacy_flagged as "privacyFlagged", ${isoz("a.last_seen_at")} as "lastSeenAt",
          a.home_icao as "homeIcao", ${isoz("a.verified_at")} as "verifiedAt"
        from corporate_aircraft a join corporate_aircraft_companies l on l.aircraft_id = a.id
        where a.active and l.company_id = ${company.id}
        order by a.confidence desc, a.registration`);
      if (!aircraft.length) return null;
      const ids = aircraft.map((a) => a.id);
      const [legs, weekly, signalRows, counts] = await Promise.all([
        ctx.db.execute<{
          id: number;
          registration: string;
          departedAt: string | null;
          arrivedAt: string | null;
          durationMin: number | null;
          depIcao: string | null;
          depCity: string | null;
          depCountry: string | null;
          arrIcao: string | null;
          arrCity: string | null;
          arrCountry: string | null;
          completeness: string;
          source: string;
        }>(sql`
          select f.id, a.registration, ${isoz("f.departed_at")} as "departedAt",
            ${isoz("f.arrived_at")} as "arrivedAt", f.duration_min as "durationMin",
            f.dep_icao as "depIcao", f.dep_city as "depCity", f.dep_country as "depCountry",
            f.arr_icao as "arrIcao", f.arr_city as "arrCity", f.arr_country as "arrCountry",
            f.completeness::text as completeness, f.source
          from aircraft_flights f join corporate_aircraft a on a.id = f.aircraft_id
          where f.aircraft_id in ${ids}
            and coalesce(f.arrived_at, f.departed_at) >= now() - interval '30 days'
          order by coalesce(f.arrived_at, f.departed_at) desc limit 50`),
        ctx.db.execute<{ weekStart: string; count: number }>(sql`
          select w::date::text as "weekStart", count(f.id)::int as count
          from generate_series(date_trunc('week', now()) - interval '25 weeks', date_trunc('week', now()), interval '1 week') w
          left join aircraft_flights f on f.aircraft_id in ${ids}
            and coalesce(f.arrived_at, f.departed_at) >= w
            and coalesce(f.arrived_at, f.departed_at) < w + interval '1 week'
          group by w order by w`),
        latestKindSignals(ctx, company.id, "travel_"),
        ctx.db.execute<{ legs30d: number; legsFull30d: number; openSky: number }>(sql`
          select count(*)::int as "legs30d",
            count(*) filter (where completeness = 'full')::int as "legsFull30d",
            count(*) filter (where source in ('opensky', 'merged'))::int as "openSky"
          from aircraft_flights where aircraft_id in ${ids}
            and coalesce(arrived_at, departed_at) >= now() - interval '30 days'`),
      ]);
      const since30 = Date.now() - 30 * 86_400_000;
      const seen = aircraft.filter((a) => a.lastSeenAt && Date.parse(a.lastSeenAt) >= since30);
      const lastSample = aircraft
        .map((a) => a.lastSeenAt)
        .filter((t): t is string => !!t)
        .sort()
        .at(-1);
      const verified = aircraft
        .map((a) => a.verifiedAt)
        .filter((t): t is string => !!t)
        .sort()
        .at(-1);
      const c = counts[0];
      return {
        aircraft: aircraft.map(({ id: _id, verifiedAt: _v, ...a }) => a),
        legs: legs.map((l) => ({
          id: l.id,
          registration: l.registration,
          departedAt: l.departedAt,
          arrivedAt: l.arrivedAt,
          durationMin: l.durationMin,
          dep: airportRef(l.depIcao, l.depCity, l.depCountry),
          arr: airportRef(l.arrIcao, l.arrCity, l.arrCountry),
          completeness: l.completeness,
          source: l.source,
        })),
        weeklyLegCounts: weekly.map((w) => ({ ...w })),
        signals: signalRows,
        coverage: {
          aircraftActive: aircraft.length,
          aircraftSeen30d: seen.length,
          legsFull30d: c?.legsFull30d ?? 0,
          legs30d: c?.legs30d ?? 0,
          lastSampleAt: lastSample ?? null,
        },
        sources: [
          "adsb.lol (ODbL)",
          "tar1090-db/Mictronics",
          "adsbdb",
          ...((c?.openSky ?? 0) > 0 ? ["OpenSky"] : []),
        ],
        registryVerifiedAt: verified ?? null,
      };
    },
    { ttlMs: 5 * MINUTE, staleMs: 30 * MINUTE },
  );
}

function mapFilter(points: Array<{ lat: number; lon: number }>): SQL {
  const parts: SQL[] = [];
  for (const p of points) {
    const dLat = MAP_RADIUS_KM / 111;
    const dLon = MAP_RADIUS_KM / (111 * Math.max(0.2, Math.cos((p.lat * Math.PI) / 180)));
    parts.push(
      sql`(p.lat between ${p.lat - dLat} and ${p.lat + dLat} and p.lon between ${p.lon - dLon} and ${p.lon + dLon})`,
    );
  }
  for (const c of CHOKEPOINTS) {
    const [[latMin, lonMin], [latMax, lonMax]] = c.box;
    parts.push(
      sql`(p.lat between ${latMin} and ${latMax} and p.lon between ${lonMin} and ${lonMax})`,
    );
  }
  return sql.join(parts, sql` or `);
}

export async function companyLogistics(
  ctx: AppContext,
  symbol: string,
): Promise<CompanyLogistics | null> {
  const company = await findCompany(ctx, symbol);
  return ctx.api.getOrLoad(
    `logistics:v2:${company.nseSymbol}`,
    async () => {
      const [facilityRows, fleetRows] = await Promise.all([
        ctx.db.execute<{
          id: number;
          slug: string;
          name: string;
          kind: string;
          lat: number;
          lon: number;
          radiusKm: number;
          role: string;
          commodityIn: string[];
          commodityOut: string[];
          exclusive: boolean;
          verifiedAt: string | null;
        }>(sql`
          select f.id, f.slug, f.name, f.kind::text as kind, f.lat, f.lon, f.radius_km as "radiusKm",
            fc.role::text as role, fc.commodity_in as "commodityIn", fc.commodity_out as "commodityOut",
            f.exclusive, ${isoz("f.verified_at")} as "verifiedAt"
          from facility_companies fc join facilities f on f.id = fc.facility_id
          where fc.company_id = ${company.id} and f.active and f.kind <> 'hq'
          order by f.exclusive desc, f.name`),
        ctx.db.execute<{
          imo: number;
          name: string;
          dwt: number | null;
          type: string | null;
          mmsi: number | null;
          class: string | null;
          lastSeenAt: string | null;
          sogKt: number | null;
        }>(sql`
          select vf.imo, vf.name, vf.dwt, vf.type, v.mmsi, v.class::text as class,
            ${isoz("v.last_seen_at")} as "lastSeenAt",
            (select p.sog_kt from vessel_positions p where p.mmsi = v.mmsi order by p.ts desc limit 1) as "sogKt"
          from vessel_fleet vf left join vessels v on v.imo = vf.imo
          where vf.company_id = ${company.id} order by vf.name`),
      ]);
      if (!facilityRows.length && !fleetRows.length) return null;
      const fids = facilityRows.length ? facilityRows.map((f) => f.id) : [-1];
      const facilityZones = fids.map((id) => `facility:${id}`);
      const zones = [...facilityZones, ...CHOKEPOINTS.map((c) => `chokepoint:${c.slug}`)];
      const [coverage, weekly, active, calls, watch, positions, signalRows, prices] =
        await Promise.all([
          ctx.db.execute<{
            zone: string;
            windows: number;
            windowsWithData: number;
            windows24h: number;
            windowsWithData24h: number;
            lastDataDay: string | null;
          }>(sql`
            select zone,
              coalesce(sum(windows) filter (where day >= current_date - 6), 0)::int as windows,
              coalesce(sum(windows_with_data) filter (where day >= current_date - 6), 0)::int as "windowsWithData",
              coalesce(sum(windows) filter (where day >= (now() - interval '24 hours')::date), 0)::int as "windows24h",
              coalesce(sum(windows_with_data) filter (where day >= (now() - interval '24 hours')::date), 0)::int as "windowsWithData24h",
              (max(day) filter (where windows_with_data > 0))::text as "lastDataDay"
            from altdata_coverage where layer = 'sea' and zone in ${zones} group by zone`),
          ctx.db.execute<{ facilityId: number; weekStart: string; count: number }>(sql`
            select f.id as "facilityId", w::date::text as "weekStart", count(c.id)::int as count
            from unnest(${sql.raw(`array[${fids.join(",")}]::int[]`)}) as f(id)
            cross join generate_series(date_trunc('week', now()) - interval '11 weeks', date_trunc('week', now()), interval '1 week') w
            left join vessel_calls c on c.facility_id = f.id and c.entered_at >= w and c.entered_at < w + interval '1 week'
            group by f.id, w order by f.id, w`),
          ctx.db.execute<LogisticsActiveVessel & { facilityId: number }>(sql`
            select c.facility_id as "facilityId", c.mmsi, v.name, v.class::text as class,
              v.size_class as "sizeClass", ${isoz("c.entered_at")} as "sinceAt", c.nav_status_mode as "navStatus"
            from vessel_calls c join vessels v on v.mmsi = c.mmsi
            where c.facility_id in ${fids} and c.left_at is null
            order by c.entered_at desc limit 200`),
          ctx.db.execute<Omit<LogisticsCallView, "cargoProxy">>(sql`
            select c.id, f.slug as "facilitySlug", c.mmsi, v.name, v.class::text as class,
              v.size_class as "sizeClass", ${isoz("c.entered_at")} as "enteredAt", ${isoz("c.left_at")} as "leftAt",
              c.dwell_min as "dwellMin", c.cargo_direction as "cargoDirection"
            from vessel_calls c join vessels v on v.mmsi = c.mmsi join facilities f on f.id = c.facility_id
            where c.facility_id in ${fids} and coalesce(c.left_at, c.entered_at) >= now() - interval '7 days'
            order by c.entered_at desc limit 50`),
          ctx.db.execute<Omit<ChokepointWatchView, "estValueCr" | "loitering">>(sql`
            select distinct on (t.mmsi) t.mmsi, v.name, v.class::text as class, v.size_class as "sizeClass",
              t.chokepoint, t.loiter_min as "loiterMin",
              coalesce(t.destination_at_entry, v.destination_raw) as destination,
              f.slug as "destinationFacilitySlug", ${isoz("v.last_seen_at")} as "lastPositionAt"
            from chokepoint_transits t join vessels v on v.mmsi = t.mmsi
            join facilities f on f.id = coalesce(v.destination_facility_id, t.destination_facility_id)
            where t.left_at is null and f.id in ${fids}
            order by t.mmsi, t.entered_at desc`),
          ctx.db.execute<MapPosition>(sql`
            select distinct on (p.mmsi) p.mmsi, p.lat, p.lon, p.cog_deg as "cogDeg", v.class::text as class,
              ${isoz("p.ts")} as ts
            from vessel_positions p join vessels v on v.mmsi = p.mmsi
            where p.ts >= now() - interval '24 hours'
              and (${mapFilter(facilityRows)})
            order by p.mmsi, p.ts desc limit 200`),
          latestKindSignals(ctx, company.id, "logistics_"),
          altdataPrices(ctx),
        ]);
      const covByZone = new Map(coverage.map((c) => [c.zone, c]));
      const facilityCoverage = coverage.filter((c) => facilityZones.includes(c.zone));
      const zoneFactor = (zone: string) => {
        const c = covByZone.get(zone);
        return c ? coverageFactor(c.windows, c.windowsWithData) : 0;
      };
      const factors = facilityRows.map((f) => zoneFactor(`facility:${f.id}`));
      const commodityFor = new Map(facilityRows.map((f) => [f.slug, f.commodityIn]));
      const lastDay = facilityCoverage
        .map((c) => c.lastDataDay)
        .filter((d): d is string => !!d)
        .sort()
        .at(-1);
      const seen7 = Date.now() - 7 * 86_400_000;
      return {
        facilities: facilityRows.map((f, i) => ({
          ...f,
          coverage7d: factors[i] ?? 0,
          arrivalsWeekly: weekly
            .filter((w) => w.facilityId === f.id)
            .map((w) => ({ weekStart: w.weekStart, count: w.count })),
          activeVessels: active
            .filter((a) => a.facilityId === f.id)
            .map(({ facilityId: _f, ...a }) => a),
        })),
        calls: calls.map((c) => {
          const product =
            c.class === "tanker" && !(commodityFor.get(c.facilitySlug) ?? []).includes("crude");
          const v = cargoValueEstimate({ class: c.class, sizeClass: c.sizeClass, product }, null);
          return { ...c, cargoProxy: { commodity: v.commodity, bbl: v.cargoBbl } };
        }),
        chokepointWatch: watch.map((w) => {
          const product =
            w.class === "tanker" &&
            !(commodityFor.get(w.destinationFacilitySlug ?? "") ?? []).includes("crude");
          return {
            ...w,
            estValueCr: cargoValueEstimate(
              { class: w.class, sizeClass: w.sizeClass, product },
              prices,
            ).estValueCr,
            loitering: w.loiterMin >= CHOKEPOINT_LOITER_MIN,
          };
        }),
        fleet: fleetRows.length
          ? {
              size: fleetRows.length,
              seen7d: fleetRows.filter((v) => v.lastSeenAt && Date.parse(v.lastSeenAt) >= seen7)
                .length,
              vessels: fleetRows.map((v) => ({ ...v })),
            }
          : null,
        signals: signalRows,
        coverage: {
          factor7d: factors.length
            ? Math.round((factors.reduce((s, v) => s + v, 0) / factors.length) * 1000) / 1000
            : 0,
          lastSampleAt: lastDay ?? null,
          windows24h: facilityCoverage.reduce((s, c) => s + c.windows24h, 0),
          windowsWithData24h: facilityCoverage.reduce((s, c) => s + c.windowsWithData24h, 0),
          chokepoints: CHOKEPOINTS.map((c) => {
            const factor7d = zoneFactor(`chokepoint:${c.slug}`);
            return {
              slug: c.slug,
              name: c.name,
              factor7d,
              covered: factor7d >= LOGISTICS_MIN_COVERAGE,
            };
          }),
        },
        positionsForMap: positions.map((p) => ({ ...p })),
        sources: ["AISStream", "company filings", "Yahoo (Brent, USDINR)"],
      };
    },
    { ttlMs: 5 * MINUTE, staleMs: 30 * MINUTE },
  );
}

export async function altdataActivity(ctx: AppContext, limit = 40): Promise<AltdataActivityItem[]> {
  const rows = await ctx.api.getOrLoad(
    `altdata:activity:${limit}`,
    async () => {
      const list = await ctx.db.execute<AltdataActivityItem>(sql`
        select e.id, e.layer, e.kind, ${isoz("e.occurred_at")} as "occurredAt", e.severity, e.headline,
          c.nse_symbol as symbol, c.name as "companyName", f.slug as "facilitySlug", e.detail
        from altdata_events e
        left join companies c on c.id = e.company_id
        left join facilities f on f.id = e.facility_id
        where e.severity >= 1
        order by e.occurred_at desc, e.id desc limit ${limit}`);
      return list.map((r) => ({ ...r }));
    },
    { ttlMs: 2 * MINUTE, staleMs: 10 * MINUTE },
  );
  return rows ?? [];
}
