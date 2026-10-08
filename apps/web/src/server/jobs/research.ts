import { HOUR, MINUTE } from "@ma/core";
import { fetchBrokerReports, syncMoneycontrol } from "@ma/ingest";
import { forEachCompany, pickBatch } from "./batch";
import type { JobDef } from "./run";

export const researchJobs: JobDef[] = [
  {
    name: "moneycontrol",
    budgetMs: 4.5 * MINUTE,
    run: async (run) => {
      const ids = await pickBatch(run.ctx, "moneycontrol", run.ctx.config.INTEL_UNIVERSE, 10, {
        maxAgeMs: 12 * HOUR,
      });
      return forEachCompany(
        run,
        ids,
        1,
        (id) => syncMoneycontrol(run.ctx, id).then((r) => (r ? { ...r } : null)),
        { reserveMs: 30_000 },
      );
    },
  },
  {
    name: "broker-reports",
    budgetMs: 4 * MINUTE,
    run: async (run) => {
      const r = await fetchBrokerReports(run.ctx, 12, { stop: () => run.expired(30_000) });
      return { ...r };
    },
  },
];
