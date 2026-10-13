import { DAY, HOUR } from "@ma/core";
import { syncAnnouncements, syncFundamentals, syncPrices, syncUniverse } from "@ma/ingest";
import { numericMetrics, pickBatch, trackCompany } from "../batch.js";
import { companies, done, fanout, type HandlerMap } from "../registry.js";

const UNIVERSE_INDICES = ["NIFTY50", "NIFTYNEXT50", "NIFTY100", "NIFTY200"];
const PRICES_MAX_AGE_MS = 12 * HOUR;
const PRICES_PER_FANOUT = 1_000;
const FUNDAMENTALS_PER_FANOUT = 30;
const ANNOUNCEMENTS_PER_FANOUT = 60;

type MarketHandlers = Pick<
  HandlerMap,
  | "universe.fanout"
  | "universe.sync"
  | "prices.fanout"
  | "prices.sync"
  | "fundamentals.fanout"
  | "fundamentals.sync"
  | "announcements.fanout"
  | "announcements.sync"
>;

export const marketHandlers: MarketHandlers = {
  "universe.fanout": async ({ ctx }) => {
    const codes = new Set([...UNIVERSE_INDICES, ctx.config.DATA_UNIVERSE]);
    return fanout(
      "universe.sync",
      [...codes].map((index) => ({ index })),
    );
  },
  "universe.sync": async ({ ctx, payload }) =>
    done(numericMetrics(await syncUniverse(ctx, payload.index))),

  "prices.fanout": async ({ ctx }) =>
    companies(
      "prices.sync",
      await pickBatch(ctx.db, "prices", ctx.config.DATA_UNIVERSE, PRICES_PER_FANOUT, {
        maxAgeMs: PRICES_MAX_AGE_MS,
      }),
    ),
  "prices.sync": async ({ ctx, payload }) => {
    const bars = await trackCompany(ctx.db, "prices", payload.companyId, () =>
      syncPrices(ctx, payload.companyId, "1mo"),
    );
    return done({ bars });
  },

  "fundamentals.fanout": async ({ ctx }) =>
    companies(
      "fundamentals.sync",
      await pickBatch(ctx.db, "fundamentals", ctx.config.DATA_UNIVERSE, FUNDAMENTALS_PER_FANOUT, {
        maxAgeMs: 3 * DAY,
      }),
    ),
  "fundamentals.sync": async ({ ctx, payload }) => {
    const r = await trackCompany(ctx.db, "fundamentals", payload.companyId, () =>
      syncFundamentals(ctx, payload.companyId),
    );
    return done(r ? { periods: r.periods, changed: r.changed ? 1 : 0 } : { missing: 1 });
  },

  "announcements.fanout": async ({ ctx }) =>
    companies(
      "announcements.sync",
      await pickBatch(ctx.db, "announcements", ctx.config.DATA_UNIVERSE, ANNOUNCEMENTS_PER_FANOUT, {
        maxAgeMs: 2 * HOUR,
      }),
    ),
  "announcements.sync": async ({ ctx, payload }) => {
    const inserted = await trackCompany(ctx.db, "announcements", payload.companyId, () =>
      syncAnnouncements(ctx, payload.companyId),
    );
    return done({ announcements: inserted });
  },
};
