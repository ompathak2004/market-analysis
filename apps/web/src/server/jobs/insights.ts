import { DeadlineExceededError, isoDate, MINUTE } from "@ma/core";
import { analystCalls, and, desc, eq, isNull, sql } from "@ma/db";
import {
  assembleCompanyInputs,
  generateBrokerDigest,
  generateCompanyBrief,
  generateMarketBrief,
  type InsightOutcome,
  summarizeBrokerReport,
  triageAnnouncements,
} from "@ma/intel";
import { markFailed, markSynced, pickBriefBatch, universeIds } from "@ma/jobs";
import { LlmBudgetExceeded, LlmInvalidOutput, LlmPromptTooLarge } from "@ma/llm";
import type { JobDef, JobStats } from "./run";

const BRIEFS_PER_RUN = 5;
const TRIAGE_PER_RUN = 60;
const THESES_PER_RUN = 10;
const RESERVE_MS = 75_000;

const tally = (stats: JobStats, outcome: InsightOutcome, kind: string) => {
  const key = typeof outcome === "string" ? `${kind}_${outcome}` : kind;
  stats[key] = (stats[key] ?? 0) + 1;
  if (typeof outcome !== "string") {
    stats.tokens =
      (stats.tokens ?? 0) + (outcome.promptTokens ?? 0) + (outcome.completionTokens ?? 0);
  }
};

export const insightJobs: JobDef[] = [
  {
    name: "insights",
    budgetMs: 4.5 * MINUTE,
    run: async (run) => {
      const { ctx } = run;
      const ids = await pickBriefBatch(ctx.db, ctx.config.INTEL_UNIVERSE, BRIEFS_PER_RUN);
      const stats: JobStats = { items: ids.length, failed: 0, skipped: 0 };
      const asOf = isoDate(new Date());
      for (const id of ids) {
        if (run.expired(RESERVE_MS)) {
          stats.skipped = (stats.skipped ?? 0) + 1;
          continue;
        }
        try {
          const inputs = await assembleCompanyInputs(ctx.db, id, asOf);
          tally(stats, await generateCompanyBrief(ctx, id, { inputs }), "brief");
          if (!run.expired(RESERVE_MS))
            tally(stats, await generateBrokerDigest(ctx, id, { inputs }), "digest");
          await markSynced(ctx.db, "insights", id);
        } catch (err) {
          if (err instanceof LlmBudgetExceeded) {
            stats.budget = 1;
            break;
          }
          if (err instanceof DeadlineExceededError) {
            stats.deadline = 1;
            break;
          }
          stats.failed = (stats.failed ?? 0) + 1;
          ctx.logger.warn({ job: run.name, companyId: id, err }, "insight generation failed");
          await markFailed(ctx.db, "insights", id, err);
        }
      }
      return stats;
    },
  },
  {
    name: "market-brief",
    budgetMs: 4 * MINUTE,
    run: async ({ ctx }) => {
      try {
        const outcome = await generateMarketBrief(ctx);
        const stats: JobStats = {};
        tally(stats, outcome, "brief");
        return stats;
      } catch (err) {
        if (err instanceof LlmBudgetExceeded) return { budget: 1 };
        if (err instanceof DeadlineExceededError) return { deadline: 1 };
        throw err;
      }
    },
  },
  {
    name: "triage",
    budgetMs: 4.5 * MINUTE,
    run: async (run) => {
      const { ctx } = run;
      const companyIds = await universeIds(ctx.db, ctx.config.INTEL_UNIVERSE);
      try {
        const stats = await triageAnnouncements(ctx, {
          limit: TRIAGE_PER_RUN,
          companyIds,
          expired: () => run.expired(RESERVE_MS),
        });
        return { ...stats };
      } catch (err) {
        if (err instanceof LlmBudgetExceeded || err instanceof DeadlineExceededError) {
          return err instanceof LlmBudgetExceeded ? { budget: 1 } : { deadline: 1 };
        }
        throw err;
      }
    },
  },
  {
    name: "broker-theses",
    budgetMs: 4.5 * MINUTE,
    run: async (run) => {
      const { ctx } = run;
      const rows = await ctx.db
        .select({ id: analystCalls.id })
        .from(analystCalls)
        .where(
          and(sql`${analystCalls.reportDocumentId} is not null`, isNull(analystCalls.summarizedAt)),
        )
        .orderBy(desc(analystCalls.publishedAt), desc(analystCalls.id))
        .limit(THESES_PER_RUN);
      const stats: JobStats = { items: rows.length, summarized: 0, skipped: 0, failed: 0 };
      for (const { id } of rows) {
        if (run.expired(RESERVE_MS)) break;
        try {
          const r = await summarizeBrokerReport(ctx, id);
          if (r === "skipped") stats.skipped = (stats.skipped ?? 0) + 1;
          else stats.summarized = (stats.summarized ?? 0) + 1;
        } catch (err) {
          if (err instanceof LlmBudgetExceeded) {
            stats.budget = 1;
            break;
          }
          if (err instanceof DeadlineExceededError) {
            stats.deadline = 1;
            break;
          }
          stats.failed = (stats.failed ?? 0) + 1;
          ctx.logger.warn({ job: run.name, analystCallId: id, err }, "broker thesis failed");
          if (err instanceof LlmInvalidOutput || err instanceof LlmPromptTooLarge) {
            await ctx.db
              .update(analystCalls)
              .set({ summarizedAt: new Date() })
              .where(eq(analystCalls.id, id));
          }
        }
      }
      return stats;
    },
  },
];
