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
import { LlmBudgetExceeded, LlmInvalidOutput, LlmPromptTooLarge } from "@ma/llm";
import type { AppContext } from "../context";
import { markFailed, markSynced, universeIds } from "./batch";
import type { JobDef, JobStats } from "./run";

const BRIEFS_PER_RUN = 5;
const TRIAGE_PER_RUN = 60;
const THESES_PER_RUN = 10;
const RESERVE_MS = 75_000;

export async function pickBriefBatch(
  ctx: AppContext,
  indexCode: string,
  limit: number,
): Promise<number[]> {
  const rows = await ctx.db.execute<{ id: number }>(sql`
    select c.id, b.generated_at from companies c
    join index_constituents ic on ic.company_id = c.id
    join indices i on i.id = ic.index_id and i.code = ${indexCode}
    left join lateral (
      select generated_at from insights
      where company_id = c.id and kind = 'company_brief' and superseded_at is null
      order by generated_at desc limit 1
    ) b on true
    left join company_sync s on s.company_id = c.id and s.job = 'insights'
    where c.listed
      and (exists (select 1 from prices_daily p where p.company_id = c.id and p.date > current_date - 10)
        or exists (select 1 from fundamentals f where f.company_id = c.id))
      and (s.failures is null or s.failures < 3 or s.attempted_at < now() - interval '6 hours')
      and (b.generated_at is null
        or s.synced_at is null
        or s.synced_at < now() - interval '20 hours'
        or exists (select 1 from announcements a where a.company_id = c.id
          and a.materiality = 'high' and a.created_at > s.synced_at))
    order by (b.generated_at is null) desc, s.synced_at asc nulls first, c.market_cap_cr desc nulls last
    limit ${limit}`);
  return rows.map((r) => r.id);
}

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
      const ids = await pickBriefBatch(ctx, ctx.config.INTEL_UNIVERSE, BRIEFS_PER_RUN);
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
          await markSynced(ctx, "insights", id);
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
          await markFailed(ctx, "insights", id, err);
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
      const companyIds = await universeIds(ctx, ctx.config.INTEL_UNIVERSE);
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
