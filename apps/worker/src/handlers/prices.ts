import { RateLimitedError } from "@ma/core";
import {
  buildBackfillManifest,
  buildDailyManifest,
  buildRepairManifest,
  dailyWindow,
  loadSeries,
  PRICE_PARSER_VERSION,
  type PriceWindowResult,
  rebuildSeries,
  syncPrices,
  syncPriceWindow,
} from "@ma/ingest";
import { DeferredError, markSynced } from "@ma/jobs";
import { numericMetrics, trackCompany } from "../batch.js";
import {
  type ChildJob,
  done,
  type HandlerMap,
  type HandlerResult,
  type UnitRun,
} from "../registry.js";

const PRICES_PER_REPAIR = 500;
const REPAIR_RESERVE_MS = 30_000;

export const PRICE_PRIORITY = { index: 2, rebuild: 1, daily: 0, backfill: -1 } as const;

type PriceHandlers = Pick<
  HandlerMap,
  | "prices.fanout"
  | "prices.repair"
  | "prices.backfill"
  | "prices.window"
  | "prices.daily"
  | "index.daily"
  | "prices.rebuild"
  | "prices.sync"
>;

export function windowMetrics(r: PriceWindowResult): Record<string, number> {
  return { ...numericMetrics(r), [r.status]: 1 };
}

function children(jobs: ChildJob[], metrics: Record<string, number> = {}): HandlerResult {
  return { metrics: { ...metrics, children: jobs.length }, children: jobs };
}

// A source-wide cooldown postpones the unit instead of burning its retry budget.
async function deferRateLimits<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof RateLimitedError && err.details?.source === "nse") {
      const wait = Number(err.details.retryAfterMs) || 60_000;
      throw new DeferredError(new Date(Date.now() + wait), err.message);
    }
    throw err;
  }
}

async function daily({
  ctx,
  payload,
  signal,
  fence,
}: UnitRun<"prices.daily" | "index.daily">): Promise<HandlerResult> {
  const ref = await loadSeries(ctx.db, payload.seriesId);
  if (!ref) return done({ missing_series: 1 });
  const window = await dailyWindow(ctx.db, payload.date);
  const r = await deferRateLimits(() =>
    syncPriceWindow(
      ctx,
      { seriesId: payload.seriesId, symbol: payload.symbol, ...window },
      "daily",
      signal,
    ),
  );
  if (ref.kind === "equity" && r.status === "written")
    await markSynced(ctx.db, "prices", ref.ownerId, fence);
  return done(windowMetrics(r));
}

export const priceHandlers: PriceHandlers = {
  "prices.fanout": async ({ ctx, signal }) => {
    const m = await buildDailyManifest(ctx, { signal });
    return children(
      [
        ...m.indices.map((payload) => ({
          type: "index.daily" as const,
          payload: { ...payload },
          priority: PRICE_PRIORITY.index,
        })),
        ...m.rebuilds.map((payload) => ({
          type: "prices.rebuild" as const,
          payload: { ...payload },
          priority: PRICE_PRIORITY.rebuild,
        })),
        ...m.equities.map((payload) => ({
          type: "prices.daily" as const,
          payload: { ...payload },
          priority: PRICE_PRIORITY.daily,
        })),
      ],
      { indices: m.indices.length, equities: m.equities.length, rebuilds: m.rebuilds.length },
    );
  },
  "prices.repair": async (run) => {
    const { ctx, signal } = run;
    const m = await buildRepairManifest(ctx, {
      limit: PRICES_PER_REPAIR,
      signal,
      deadline: () => run.expired(REPAIR_RESERVE_MS),
    });
    return children(
      [
        ...m.rebuilds.map((payload) => ({
          type: "prices.rebuild" as const,
          payload: { ...payload },
          priority: PRICE_PRIORITY.rebuild,
        })),
        ...m.refetch.map((u) => ({
          type: "prices.window" as const,
          payload: { ...u, mode: "repair" },
          priority: PRICE_PRIORITY.backfill,
        })),
      ],
      { reconciled: m.reconciled, openGaps: m.openGaps, rebuilds: m.rebuilds.length },
    );
  },
  "prices.backfill": async ({ ctx, signal }) => {
    const m = await buildBackfillManifest(ctx, { signal });
    for (const e of m.exceptions) ctx.logger.warn({ ...e }, "price backfill listing exception");
    return children(
      m.units.map((payload) => ({
        type: "prices.window" as const,
        payload: { ...payload },
        priority: PRICE_PRIORITY.backfill,
      })),
      { series: m.series, exceptions: m.exceptions.length },
    );
  },
  "prices.window": async ({ ctx, payload, signal }) => {
    if (payload.parserVersion !== PRICE_PARSER_VERSION) return done({ stale_parser: 1 });
    const r = await deferRateLimits(() =>
      syncPriceWindow(
        ctx,
        {
          seriesId: payload.seriesId,
          symbol: payload.symbol,
          from: payload.from,
          toExclusive: payload.toExclusive,
          generation: payload.generation,
        },
        payload.mode ?? "backfill",
        signal,
      ),
    );
    return done(windowMetrics(r));
  },
  "prices.daily": daily,
  "index.daily": daily,
  "prices.rebuild": async ({ ctx, payload, signal }) => {
    if (payload.parserVersion !== PRICE_PARSER_VERSION) return done({ stale_parser: 1 });
    const r = await rebuildSeries(ctx, payload, signal);
    return done(windowMetrics(r));
  },
  "prices.sync": async (run) => {
    const { ctx, payload, signal } = run;
    const bars = await trackCompany(run, "prices", payload.companyId, () =>
      syncPrices(ctx, payload.companyId, payload.range ?? "1mo", signal),
    );
    return done({ bars });
  },
};
