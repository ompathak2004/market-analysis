import { fetchBrokerReports, syncMoneycontrol } from "@ma/ingest";
import { forEachCompany, pickBatch } from "./batch";
import type { JobDef } from "./registry";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const researchJobs: JobDef[] = [
  {
    name: "moneycontrol",
    budgetMs: 4.5 * MINUTE,
    run: async (run) => {
      const ids = await pickBatch(run.ctx, "moneycontrol", run.ctx.config.INTEL_UNIVERSE, 10, {
        maxAgeMs: 12 * HOUR,
      });
      const stats = await forEachCompany(
        run,
        ids,
        1,
        (id) => syncMoneycontrol(run.ctx, id).then((r) => (r ? { ...r } : null)),
        { reserveMs: 30_000 },
      );
      await run.ctx.api.invalidatePrefix("analysts:");
      await run.ctx.api.invalidatePrefix("research:");
      await run.ctx.api.invalidatePrefix("company:");
      return stats;
    },
  },
  {
    name: "broker-reports",
    budgetMs: 4 * MINUTE,
    run: async (run) => {
      const r = await fetchBrokerReports(run.ctx, 12, { stop: () => run.expired(30_000) });
      if (r.linked > 0) await run.ctx.api.invalidatePrefix("analysts:");
      return { ...r };
    },
  },
];
