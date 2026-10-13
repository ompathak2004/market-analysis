import { isoDate } from "@ma/core";
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
import { LlmInvalidOutput, LlmPromptTooLarge } from "@ma/llm";
import { type Metrics, markFailed, trackCompany, universeIds } from "../batch.js";
import type { WorkerContext } from "../context.js";
import { companies, done, fanout, type HandlerMap } from "../registry.js";

const BRIEFS_PER_FANOUT = 5;
const TRIAGE_PER_RUN = 60;
const THESES_PER_FANOUT = 10;
const TRIAGE_RESERVE_MS = 30_000;

export async function pickBriefBatch(
  ctx: WorkerContext,
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
  return rows.map((r) => Number(r.id));
}

export function tally(metrics: Metrics, outcome: InsightOutcome, kind: string): Metrics {
  const key = typeof outcome === "string" ? `${kind}_${outcome}` : kind;
  metrics[key] = (metrics[key] ?? 0) + 1;
  if (typeof outcome !== "string") {
    metrics.tokens =
      (metrics.tokens ?? 0) + (outcome.promptTokens ?? 0) + (outcome.completionTokens ?? 0);
  }
  return metrics;
}

type InsightHandlers = Pick<
  HandlerMap,
  | "insights.fanout"
  | "insights.company"
  | "insights.digest"
  | "market-brief"
  | "triage.batch"
  | "broker.theses"
  | "broker.thesis"
>;

export const insightHandlers: InsightHandlers = {
  "insights.fanout": async ({ ctx }) =>
    companies(
      "insights.company",
      await pickBriefBatch(ctx, ctx.config.INTEL_UNIVERSE, BRIEFS_PER_FANOUT),
    ),
  "insights.company": async ({ ctx, payload }) => {
    const metrics: Metrics = {};
    try {
      const inputs = await assembleCompanyInputs(ctx.db, payload.companyId, isoDate(new Date()));
      tally(metrics, await generateCompanyBrief(ctx, payload.companyId, { inputs }), "brief");
    } catch (err) {
      await markFailed(ctx.db, "insights", payload.companyId, err).catch(() => undefined);
      throw err;
    }
    return {
      metrics,
      children: [{ type: "insights.digest", payload: { companyId: payload.companyId } }],
    };
  },
  "insights.digest": async ({ ctx, payload }) =>
    trackCompany(ctx.db, "insights", payload.companyId, async () => {
      const inputs = await assembleCompanyInputs(ctx.db, payload.companyId, isoDate(new Date()));
      const outcome = await generateBrokerDigest(ctx, payload.companyId, { inputs });
      return done(tally({}, outcome, "digest"));
    }),
  "market-brief": async ({ ctx }) => done(tally({}, await generateMarketBrief(ctx), "brief")),
  "triage.batch": async ({ ctx, expired }) => {
    const companyIds = await universeIds(ctx.db, ctx.config.INTEL_UNIVERSE);
    const stats = await triageAnnouncements(ctx, {
      limit: TRIAGE_PER_RUN,
      companyIds,
      expired: () => expired(TRIAGE_RESERVE_MS),
    });
    return done({ ...stats });
  },
  "broker.theses": async ({ ctx }) => {
    const rows = await ctx.db
      .select({ id: analystCalls.id })
      .from(analystCalls)
      .where(
        and(sql`${analystCalls.reportDocumentId} is not null`, isNull(analystCalls.summarizedAt)),
      )
      .orderBy(desc(analystCalls.publishedAt), desc(analystCalls.id))
      .limit(THESES_PER_FANOUT);
    return fanout(
      "broker.thesis",
      rows.map(({ id }) => ({ callId: id })),
    );
  },
  "broker.thesis": async ({ ctx, payload }) => {
    try {
      const r = await summarizeBrokerReport(ctx, payload.callId);
      return done(r === "skipped" ? { skipped: 1 } : { summarized: 1 });
    } catch (err) {
      if (err instanceof LlmInvalidOutput || err instanceof LlmPromptTooLarge) {
        await ctx.db
          .update(analystCalls)
          .set({ summarizedAt: new Date() })
          .where(eq(analystCalls.id, payload.callId));
      }
      throw err;
    }
  },
};
