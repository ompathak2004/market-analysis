import { DAY, HOUR } from "@ma/core";
import { syncAnnouncements, syncFundamentals, syncUniverse } from "@ma/ingest";
import { pickBatch } from "@ma/jobs";
import { numericMetrics, trackCompany } from "../batch.js";
import { companies, done, fanout, type HandlerMap } from "../registry.js";

const UNIVERSE_INDICES = ["NIFTY50", "NIFTYNEXT50", "NIFTY100", "NIFTY200"];
const FUNDAMENTALS_PER_FANOUT = 30;
const ANNOUNCEMENTS_PER_FANOUT = 60;

type MarketHandlers = Pick<
  HandlerMap,
  | "universe.fanout"
  | "universe.sync"
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
  "universe.sync": async ({ ctx, payload, signal }) =>
    done(numericMetrics(await syncUniverse(ctx, payload.index, signal))),

  "fundamentals.fanout": async ({ ctx }) =>
    companies(
      "fundamentals.sync",
      await pickBatch(ctx.db, "fundamentals", ctx.config.DATA_UNIVERSE, FUNDAMENTALS_PER_FANOUT, {
        maxAgeMs: 3 * DAY,
      }),
    ),
  "fundamentals.sync": async (run) => {
    const { ctx, payload, signal } = run;
    const r = await trackCompany(run, "fundamentals", payload.companyId, () =>
      syncFundamentals(ctx, payload.companyId, signal),
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
  "announcements.sync": async (run) => {
    const { ctx, payload, signal } = run;
    const r = await trackCompany(run, "announcements", payload.companyId, () =>
      syncAnnouncements(ctx, payload.companyId, signal),
    );
    return done({ announcements: r.inserted, reclassified: r.reclassified, noise: r.noise });
  },
};
