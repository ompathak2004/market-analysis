import { AppError, DAY, HOUR, isoDate, MINUTE } from "@ma/core";
import { companies, sql } from "@ma/db";
import {
  extractRelationshipsForCompany,
  loadAliasMatcher,
  priceSynced,
  syncAnnouncements,
  syncCompanyPrices,
  syncFundamentals,
  syncUniverse,
  windowOutcome,
} from "@ma/ingest";
import { refreshEstimates, refreshMomentumSignals, refreshRiskSignals } from "@ma/intel";
import { pickBatch } from "@ma/jobs";
import { forEachCompany, sumStats } from "./batch";
import type { JobDef } from "./run";

export const coreJobs: JobDef[] = [
  {
    name: "universe",
    budgetMs: 4 * MINUTE,
    run: async ({ ctx }) => {
      const codes = ["NIFTY50", "NIFTYNEXT50", "NIFTY100", "NIFTY200", ctx.config.DATA_UNIVERSE];
      const results = [];
      for (const code of new Set(codes)) results.push(await syncUniverse(ctx, code));
      return sumStats(results);
    },
  },
  {
    name: "prices",
    budgetMs: 4.5 * MINUTE,
    run: async (run) => {
      const ids = await pickBatch(run.ctx.db, "prices", run.ctx.config.DATA_UNIVERSE, 400, {
        maxAgeMs: 12 * MINUTE,
      });
      return forEachCompany(
        run,
        ids,
        run.ctx.config.SCRAPE_CONCURRENCY,
        async (id) => {
          const r = await syncCompanyPrices(run.ctx, id, "1mo");
          const outcome = windowOutcome(r);
          if (outcome === "retry" || outcome === "defer")
            throw new AppError(r.detail ?? `prices ${r.status}`, "price_incomplete", 503);
          return { bars: r.inserted + r.updated + r.unchanged, synced: priceSynced(r) ? 1 : 0 };
        },
        { isSynced: (s) => s.synced === 1 },
      );
    },
  },
  {
    name: "fundamentals",
    budgetMs: 4.5 * MINUTE,
    run: async (run) => {
      const ids = await pickBatch(run.ctx.db, "fundamentals", run.ctx.config.DATA_UNIVERSE, 30, {
        maxAgeMs: 3 * DAY,
      });
      return forEachCompany(run, ids, 2, (id) =>
        syncFundamentals(run.ctx, id).then((r) =>
          r ? { periods: r.periods, changed: r.changed ? 1 : 0 } : null,
        ),
      );
    },
  },
  {
    name: "announcements",
    budgetMs: 4.5 * MINUTE,
    run: async (run) => {
      const ids = await pickBatch(run.ctx.db, "announcements", run.ctx.config.DATA_UNIVERSE, 60, {
        maxAgeMs: 2 * HOUR,
      });
      return forEachCompany(run, ids, 1, (id) => syncAnnouncements(run.ctx, id));
    },
  },
  {
    name: "relationships",
    budgetMs: 4.5 * MINUTE,
    run: async (run) => {
      const ids = await pickBatch(run.ctx.db, "relationships", run.ctx.config.DATA_UNIVERSE, 6, {
        maxAgeMs: 14 * DAY,
        where: sql`c.industry !~* 'bank|financ|insurance'`,
      });
      const matcher = await loadAliasMatcher(run.ctx);
      const stats = await forEachCompany(
        run,
        ids,
        1,
        async (id) => {
          const f = await syncFundamentals(run.ctx, id);
          if (!f) return null;
          const sources = [
            ...f.annualReports.slice(0, 2).map((a) => ({ ...a, kind: "annual_report" as const })),
            ...f.concalls.slice(0, 4).map((c) => ({ ...c, kind: "concall" as const })),
          ];
          const r = await extractRelationshipsForCompany(run.ctx, id, sources, matcher);
          return { documents: r.documents, relationships: r.relationships };
        },
        { reserveMs: 60_000 },
      );
      return stats;
    },
  },
  {
    name: "intel",
    budgetMs: 4.5 * MINUTE,
    run: async ({ ctx }) => {
      const asOf = isoDate(new Date());
      const ids = (await ctx.db.select({ id: companies.id }).from(companies)).map((c) => c.id);
      const estimates = await refreshEstimates(ctx.db, asOf);
      const momentum = await refreshMomentumSignals(ctx.db, asOf);
      const risk = await refreshRiskSignals(ctx.db, ids, asOf);
      return { estimates, momentum, risk };
    },
  },
];
