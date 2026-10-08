import { MINUTE } from "@ma/core";
import {
  airportByIcao,
  CHOKEPOINTS,
  cleanupAltdataPositions,
  collectVesselPositions,
  DEAL_HUBS,
  deriveAircraftFlights,
  deriveVesselActivity,
  OpenSkySource,
  sampleAircraftPositions,
  seedAircraftRegistry,
  seedFacilities,
  syncFleets,
} from "@ma/ingest";
import { refreshLogisticsSignals, refreshTravelSignals } from "@ma/intel";
import type { AppContext } from "../context";
import { altdataPrices } from "../queries/altdata";
import type { JobDef, JobRun, JobStats } from "./run";

function prefixed(prefix: string, stats: Record<string, number>): JobStats {
  const out: JobStats = {};
  for (const [k, v] of Object.entries(stats)) out[`${prefix}.${k}`] = v;
  return out;
}

function altdataJob(
  name: string,
  budgetMs: number,
  fn: (run: JobRun) => Promise<JobStats>,
): JobDef {
  return {
    name,
    budgetMs,
    run: async (run) => (run.ctx.config.ALTDATA_ENABLED ? fn(run) : { disabled: 1 }),
  };
}

function openSky(ctx: AppContext): OpenSkySource | null {
  const { OPENSKY_CLIENT_ID: clientId, OPENSKY_CLIENT_SECRET: clientSecret } = ctx.config;
  const creds = clientId && clientSecret ? { clientId, clientSecret } : null;
  return new OpenSkySource(ctx.http, ctx.redis, ctx.logger.child({ component: "opensky" }), creds);
}

function airportPoint(icao: string): { lat: number; lon: number } | null {
  const a = airportByIcao(icao);
  return a ? { lat: a.lat, lon: a.lon } : null;
}

export const altdataJobs: JobDef[] = [
  altdataJob("aircraft-registry", 4 * MINUTE, async (run) => {
    const facilities = await seedFacilities(run.ctx);
    const registry = await seedAircraftRegistry(run.ctx, { deadline: run.deadline - 20_000 });
    return { ...prefixed("facilities", facilities), ...prefixed("registry", registry) };
  }),
  altdataJob("aircraft-sample", MINUTE, async (run) => {
    return sampleAircraftPositions(run.ctx, { deadline: run.deadline - 5_000 });
  }),
  altdataJob("ais-collect", 2 * MINUTE, async (run) => {
    const apiKey = run.ctx.config.AISSTREAM_API_KEY;
    if (!apiKey) return { skipped: 1 };
    return collectVesselPositions(run.ctx, {
      apiKey,
      seconds: run.ctx.config.ALTDATA_AIS_BURST_SECONDS,
      deadline: run.deadline - 15_000,
    });
  }),
  altdataJob("altdata-derive", 4 * MINUTE, async (run) => {
    const now = new Date();
    const air = await deriveAircraftFlights(run.ctx, {
      deadline: run.deadline - 90_000,
      opensky: openSky(run.ctx),
      now,
    });
    const sea = await deriveVesselActivity(run.ctx, { deadline: run.deadline - 10_000, now });
    return { ...prefixed("air", air), ...prefixed("sea", sea) };
  }),
  altdataJob("altdata-signals", 4 * MINUTE, async (run) => {
    const now = new Date();
    const travel = await refreshTravelSignals(run.ctx.db, {
      dealHubs: DEAL_HUBS,
      airport: airportPoint,
      now,
      deadline: run.deadline - 90_000,
    });
    const prices = await altdataPrices(run.ctx);
    const logistics = await refreshLogisticsSignals(run.ctx.db, {
      prices,
      chokepointSlugs: CHOKEPOINTS.map((c) => c.slug),
      now,
      deadline: run.deadline - 10_000,
    });
    return {
      ...prefixed("travel", { ...travel }),
      ...prefixed("logistics", { ...logistics }),
      pricesAvailable: prices ? 1 : 0,
    };
  }),
  altdataJob("fleets", 4 * MINUTE, async (run) => {
    return syncFleets(run.ctx, { deadline: run.deadline - 15_000 });
  }),
  altdataJob("altdata-cleanup", 2 * MINUTE, async (run) =>
    cleanupAltdataPositions(run.ctx, { deadline: run.deadline - 10_000 }),
  ),
];
