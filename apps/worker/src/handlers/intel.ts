import { isoDate } from "@ma/core";
import { companies as companiesTable } from "@ma/db";
import {
  refreshConcentrationSignals,
  refreshEstimates,
  refreshMomentumSignals,
  refreshRiskSignals,
} from "@ma/intel";
import { done, fanout, type HandlerMap } from "../registry.js";

type IntelHandlers = Pick<HandlerMap, "intel.fanout" | "intel.network" | "intel.refresh">;

export const intelHandlers: IntelHandlers = {
  "intel.fanout": async () => fanout("intel.network", [{ asOf: isoDate(new Date()) }]),
  "intel.network": async ({ ctx, payload, signal }) => {
    const estimates = await refreshEstimates(
      ctx.db,
      payload.asOf,
      ctx.config.INTEL_UNIVERSE,
      signal,
    );
    const momentum = await refreshMomentumSignals(ctx.db, payload.asOf);
    const concentration = await refreshConcentrationSignals(ctx.db, payload.asOf, signal);
    const ids = await ctx.db.select({ id: companiesTable.id }).from(companiesTable);
    const next = fanout(
      "intel.refresh",
      ids.map(({ id }) => ({ companyId: id, asOf: payload.asOf })),
    );
    return { ...next, metrics: { ...next.metrics, estimates, momentum, concentration } };
  },
  "intel.refresh": async ({ ctx, payload }) =>
    done({ risk: await refreshRiskSignals(ctx.db, [payload.companyId], payload.asOf) }),
};
