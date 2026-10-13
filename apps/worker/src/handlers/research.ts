import { HOUR } from "@ma/core";
import { fetchBrokerReports, syncMoneycontrol } from "@ma/ingest";
import { numericMetrics, pickBatch, trackCompany } from "../batch.js";
import { companies, done, type HandlerMap } from "../registry.js";

const RESEARCH_PER_FANOUT = 10;
const BROKER_REPORTS_PER_RUN = 12;
const BROKER_RESERVE_MS = 30_000;

type ResearchHandlers = Pick<HandlerMap, "research.fanout" | "research.sync" | "broker.fetch">;

export const researchHandlers: ResearchHandlers = {
  "research.fanout": async ({ ctx }) =>
    companies(
      "research.sync",
      await pickBatch(ctx.db, "moneycontrol", ctx.config.INTEL_UNIVERSE, RESEARCH_PER_FANOUT, {
        maxAgeMs: 12 * HOUR,
      }),
    ),
  "research.sync": async ({ ctx, payload }) => {
    const r = await trackCompany(ctx.db, "moneycontrol", payload.companyId, () =>
      syncMoneycontrol(ctx, payload.companyId),
    );
    return done(r ? numericMetrics(r) : { missing: 1 });
  },
  "broker.fetch": async ({ ctx, expired }) =>
    done(
      numericMetrics(
        await fetchBrokerReports(ctx, BROKER_REPORTS_PER_RUN, {
          stop: () => expired(BROKER_RESERVE_MS),
        }),
      ),
    ),
};
