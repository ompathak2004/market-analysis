import { MINUTE } from "@ma/core";
import {
  airportByIcao,
  CHOKEPOINTS,
  cleanupAltdataPositions,
  collectAircraftTraces,
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
import { type Prices, refreshLogisticsSignals, refreshTravelSignals } from "@ma/intel";
import { type Metrics, numericMetrics } from "../batch.js";
import type { WorkerContext } from "../context.js";
import { done, type Handler, type HandlerMap, type UnitRun } from "../registry.js";

const PRICE_TTL_MS = 15 * MINUTE;

type AltdataType =
  | "aircraft.registry"
  | "aircraft.sample"
  | "aircraft.trace"
  | "ais.collect"
  | "altdata.derive"
  | "altdata.signals"
  | "fleets"
  | "altdata.cleanup";

function prefixed(prefix: string, stats: unknown): Metrics {
  return numericMetrics(stats, `${prefix}.`);
}

function gated<T extends AltdataType>(fn: (run: UnitRun<T>) => Promise<Metrics>): Handler<T> {
  return async (run) =>
    run.ctx.config.ALTDATA_ENABLED ? done(await fn(run)) : done({ disabled: 1 });
}

function openSky(ctx: WorkerContext): OpenSkySource {
  const { OPENSKY_CLIENT_ID: clientId, OPENSKY_CLIENT_SECRET: clientSecret } = ctx.config;
  const creds = clientId && clientSecret ? { clientId, clientSecret } : null;
  return new OpenSkySource(ctx.http, ctx.redis, ctx.logger.child({ component: "opensky" }), creds);
}

function airportPoint(icao: string): { lat: number; lon: number } | null {
  const a = airportByIcao(icao);
  return a ? { lat: a.lat, lon: a.lon } : null;
}

export async function altdataPrices(ctx: WorkerContext): Promise<Prices | null> {
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

export const altdataHandlers: Pick<HandlerMap, AltdataType> = {
  "aircraft.registry": gated(async ({ ctx, deadline, signal }) => {
    const facilities = await seedFacilities(ctx, signal);
    const registry = await seedAircraftRegistry(ctx, { deadline: deadline - 20_000, signal });
    return { ...prefixed("facilities", facilities), ...prefixed("registry", registry) };
  }),
  "aircraft.sample": gated(async ({ ctx, deadline, signal }) =>
    numericMetrics(await sampleAircraftPositions(ctx, { deadline: deadline - 5_000, signal })),
  ),
  "aircraft.trace": gated(async ({ ctx, payload, deadline, signal }) =>
    numericMetrics(
      await collectAircraftTraces(ctx, { day: payload.day, deadline: deadline - 15_000, signal }),
    ),
  ),
  "ais.collect": gated(async ({ ctx, deadline, signal }) => {
    const apiKey = ctx.config.AISSTREAM_API_KEY;
    if (!apiKey) return { skipped: 1 };
    return numericMetrics(
      await collectVesselPositions(ctx, {
        apiKey,
        seconds: ctx.config.ALTDATA_AIS_BURST_SECONDS,
        deadline: deadline - 15_000,
        signal,
      }),
    );
  }),
  "altdata.derive": gated(async ({ ctx, deadline, signal }) => {
    const now = new Date();
    const air = await deriveAircraftFlights(ctx, {
      deadline: deadline - 90_000,
      signal,
      opensky: openSky(ctx),
      now,
    });
    const sea = await deriveVesselActivity(ctx, { deadline: deadline - 10_000, signal, now });
    return { ...prefixed("air", air), ...prefixed("sea", sea) };
  }),
  "altdata.signals": gated(async ({ ctx, deadline }) => {
    const now = new Date();
    const travel = await refreshTravelSignals(ctx.db, {
      dealHubs: DEAL_HUBS,
      airport: airportPoint,
      now,
      deadline: deadline - 90_000,
    });
    const prices = await altdataPrices(ctx);
    const logistics = await refreshLogisticsSignals(ctx.db, {
      prices,
      chokepointSlugs: CHOKEPOINTS.map((c) => c.slug),
      now,
      deadline: deadline - 10_000,
    });
    return {
      ...prefixed("travel", travel),
      ...prefixed("logistics", logistics),
      pricesAvailable: prices ? 1 : 0,
    };
  }),
  fleets: gated(async ({ ctx, deadline, signal }) =>
    numericMetrics(await syncFleets(ctx, { deadline: deadline - 15_000, signal })),
  ),
  "altdata.cleanup": gated(async ({ ctx, deadline, signal }) =>
    numericMetrics(await cleanupAltdataPositions(ctx, { deadline: deadline - 10_000, signal })),
  ),
};
