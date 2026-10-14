import { AppError, MINUTE, RateLimitedError } from "@ma/core";
import {
  buildBackfillManifest,
  buildDailyManifest,
  buildRepairManifest,
  dailyWindow,
  loadSeries,
  PRICE_PARSER_VERSION,
  type PriceWindowResult,
  priceSynced,
  rebuildSeries,
  syncCompanyPrices,
  syncPriceWindow,
  windowOutcome,
} from "@ma/ingest";
import { DeferredError, type JobType, markSynced } from "@ma/jobs";
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

export const PRICE_PRIORITY = {
  calendar: 3,
  index: 2,
  rebuild: 1,
  daily: 0,
  backfill: -1,
} as const;
export const CALENDAR_WAIT_MS = 3 * MINUTE;

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
  const source = r.sourceStatus === "ok" ? {} : { [`source_${r.sourceStatus}`]: 1 };
  return { ...numericMetrics(r), [r.status]: 1, ...source };
}

function children(jobs: ChildJob[], metrics: Record<string, number> = {}): HandlerResult {
  return { metrics: { ...metrics, children: jobs.length }, children: jobs };
}

const child =
  (type: JobType, priority: number) =>
  (payload: object): ChildJob => ({ type, payload: { ...payload }, priority });

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

export function requireComplete(r: PriceWindowResult, now = Date.now()): PriceWindowResult {
  const outcome = windowOutcome(r);
  if (outcome === "defer")
    throw new DeferredError(
      new Date(now + CALENDAR_WAIT_MS),
      r.detail ?? "trading calendar not ready for window",
    );
  if (outcome === "retry")
    throw new AppError(
      r.detail ?? `price window ${r.status}/${r.sourceStatus}`,
      "price_incomplete",
      503,
      {
        status: r.status,
        sourceStatus: r.sourceStatus,
        windowMissing: r.windowMissing,
        missingSessions: r.missingSessions,
      },
    );
  return r;
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
  requireComplete(r);
  if (ref.kind === "equity" && priceSynced(r))
    await markSynced(ctx.db, "prices", ref.ownerId, fence);
  return done(windowMetrics(r));
}

export const priceHandlers: PriceHandlers = {
  "prices.fanout": async ({ ctx, signal }) => {
    const m = await buildDailyManifest(ctx, { signal });
    return children(
      [
        ...m.indices.map(child("index.daily", PRICE_PRIORITY.index)),
        ...m.rebuilds.map(child("prices.rebuild", PRICE_PRIORITY.rebuild)),
        ...m.equities.map(child("prices.daily", PRICE_PRIORITY.daily)),
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
        ...m.rebuilds.map(child("prices.rebuild", PRICE_PRIORITY.rebuild)),
        ...m.refetch.map((u) =>
          child("prices.window", PRICE_PRIORITY.backfill)({ ...u, mode: "repair" }),
        ),
      ],
      { reconciled: m.reconciled, openGaps: m.openGaps, rebuilds: m.rebuilds.length },
    );
  },
  "prices.backfill": async ({ ctx, signal }) => {
    const m = await buildBackfillManifest(ctx, { signal });
    for (const e of m.exceptions) ctx.logger.warn({ ...e }, "price backfill listing exception");
    const indices = new Set(m.indexSeriesIds);
    const priority = (seriesId: number) =>
      seriesId === m.calendarSeriesId
        ? PRICE_PRIORITY.calendar
        : indices.has(seriesId)
          ? PRICE_PRIORITY.index
          : PRICE_PRIORITY.backfill;
    return children(
      m.units.map((u) => child("prices.window", priority(u.seriesId))(u)),
      {
        manifestId: m.manifestId,
        companies: m.companies,
        series: m.series,
        exceptions: m.exceptions.length,
      },
    );
  },
  "prices.window": async ({ ctx, payload, signal }) => {
    if (payload.parserVersion !== PRICE_PARSER_VERSION) return done({ stale_parser: 1 });
    const mode = payload.mode ?? "backfill";
    const r = await deferRateLimits(() => syncPriceWindow(ctx, payload, mode, signal));
    if (mode !== "repair" || windowOutcome(r) === "defer") requireComplete(r);
    return done(windowMetrics(r));
  },
  "prices.daily": daily,
  "index.daily": daily,
  "prices.rebuild": async ({ ctx, payload, signal }) => {
    if (payload.parserVersion !== PRICE_PARSER_VERSION) return done({ stale_parser: 1 });
    const r = await rebuildSeries(ctx, payload, signal);
    return done(windowMetrics(requireComplete(r)));
  },
  "prices.sync": async (run) => {
    const { ctx, payload, signal } = run;
    const r = await trackCompany(
      run,
      "prices",
      payload.companyId,
      async () =>
        requireComplete(
          await deferRateLimits(() =>
            syncCompanyPrices(ctx, payload.companyId, payload.range ?? "1mo", signal),
          ),
        ),
      priceSynced,
    );
    return done({ ...windowMetrics(r), bars: r.inserted + r.updated + r.unchanged });
  },
};
