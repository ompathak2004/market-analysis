import { DAY } from "@ma/core";
import { syncGovernance, syncPerimeter, syncRelatedParties } from "@ma/intel";
import { pickBatch } from "@ma/jobs";
import { numericMetrics, trackCompany } from "../batch.js";
import { companies, done, type HandlerMap } from "../registry.js";

const INFLUENCE_PER_FANOUT = 120;
const INFLUENCE_MAX_AGE_MS = 6 * DAY;

type InfluenceHandlers = Pick<
  HandlerMap,
  | "influence.governance.fanout"
  | "influence.governance"
  | "influence.rpt.fanout"
  | "influence.rpt"
  | "influence.perimeter.fanout"
  | "influence.perimeter"
>;

export const influenceHandlers: InfluenceHandlers = {
  "influence.governance.fanout": async ({ ctx }) =>
    companies(
      "influence.governance",
      await pickBatch(
        ctx.db,
        "influence_governance",
        ctx.config.INTEL_UNIVERSE,
        INFLUENCE_PER_FANOUT,
        {
          maxAgeMs: INFLUENCE_MAX_AGE_MS,
        },
      ),
    ),
  "influence.governance": async (run) => {
    const { ctx, payload, signal } = run;
    const r = await trackCompany(run, "influence_governance", payload.companyId, () =>
      syncGovernance(ctx, payload.companyId, { signal }),
    );
    return done({ ...numericMetrics(r), [r.status]: 1 });
  },
  "influence.rpt.fanout": async ({ ctx }) =>
    companies(
      "influence.rpt",
      await pickBatch(ctx.db, "influence_rpt", ctx.config.INTEL_UNIVERSE, INFLUENCE_PER_FANOUT, {
        maxAgeMs: INFLUENCE_MAX_AGE_MS,
      }),
    ),
  "influence.rpt": async (run) => {
    const { ctx, payload, signal } = run;
    const r = await trackCompany(run, "influence_rpt", payload.companyId, () =>
      syncRelatedParties(ctx, payload.companyId, { signal }),
    );
    return done({ ...numericMetrics(r), [r.status]: 1 });
  },
  "influence.perimeter.fanout": async ({ ctx }) =>
    companies(
      "influence.perimeter",
      await pickBatch(
        ctx.db,
        "influence_perimeter",
        ctx.config.INTEL_UNIVERSE,
        INFLUENCE_PER_FANOUT,
        {
          maxAgeMs: INFLUENCE_MAX_AGE_MS,
        },
      ),
    ),
  "influence.perimeter": async (run) => {
    const { ctx, payload, signal } = run;
    const r = await trackCompany(run, "influence_perimeter", payload.companyId, () =>
      syncPerimeter(ctx, payload.companyId, signal),
    );
    return done(numericMetrics(r));
  },
};
