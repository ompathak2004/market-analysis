import { DAY, HOUR } from "@ma/core";
import { sql } from "@ma/db";
import { syncAnnouncements, syncFundamentals, syncPrices, syncUniverse } from "@ma/ingest";
import { pickBatch } from "@ma/jobs";
import { numericMetrics, trackCompany } from "../batch.js";
import { companies, done, fanout, type HandlerMap } from "../registry.js";

const UNIVERSE_INDICES = ["NIFTY50", "NIFTYNEXT50", "NIFTY100", "NIFTY200"];
const PRICES_MAX_AGE_MS = 12 * HOUR;
const PRICES_PER_FANOUT = 1_000;
const FUNDAMENTALS_PER_FANOUT = 30;
const ANNOUNCEMENTS_PER_FANOUT = 60;
const STALE_TRADING_DAYS = 3;
const MIN_HISTORY_RATIO = 0.9;

const PRICE_GAPS = sql`
  coalesce((select max(p.date) from prices_daily p where p.company_id = c.id), date '1900-01-01')
    < coalesce(
      (select d.date from (select distinct date from prices_daily where date > current_date - 30) d
        order by d.date desc offset ${STALE_TRADING_DAYS - 1} limit 1),
      current_date - 5)
  or (select count(*) from prices_daily p where p.company_id = c.id and p.date > current_date - 365)
    < ${MIN_HISTORY_RATIO} * (select count(distinct date) from prices_daily where date > current_date - 365)`;

type MarketHandlers = Pick<
  HandlerMap,
  | "universe.fanout"
  | "universe.sync"
  | "prices.fanout"
  | "prices.repair"
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
  "universe.sync": async ({ ctx, payload, signal }) =>
    done(numericMetrics(await syncUniverse(ctx, payload.index, signal))),

  "prices.fanout": async ({ ctx }) =>
    companies(
      "prices.sync",
      await pickBatch(ctx.db, "prices", ctx.config.DATA_UNIVERSE, PRICES_PER_FANOUT, {
        maxAgeMs: PRICES_MAX_AGE_MS,
      }),
    ),
  "prices.repair": async ({ ctx }) => {
    const ids = await pickBatch(ctx.db, "prices", ctx.config.DATA_UNIVERSE, PRICES_PER_FANOUT, {
      where: PRICE_GAPS,
    });
    return fanout(
      "prices.sync",
      ids.map((companyId) => ({ companyId, range: "1y" })),
    );
  },
  "prices.sync": async (run) => {
    const { ctx, payload, signal } = run;
    const bars = await trackCompany(run, "prices", payload.companyId, () =>
      syncPrices(ctx, payload.companyId, payload.range ?? "1mo", signal),
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
    const inserted = await trackCompany(run, "announcements", payload.companyId, () =>
      syncAnnouncements(ctx, payload.companyId, signal),
    );
    return done({ announcements: inserted });
  },
};
