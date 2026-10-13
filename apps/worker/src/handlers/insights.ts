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
import { markFailed, pickBriefBatch, universeIds } from "@ma/jobs";
import { LlmInvalidOutput, LlmPromptTooLarge } from "@ma/llm";
import { type Metrics, trackCompany } from "../batch.js";
import { companies, done, fanout, type HandlerMap } from "../registry.js";

const BRIEFS_PER_FANOUT = 5;
const TRIAGE_PER_RUN = 60;
const THESES_PER_FANOUT = 10;
const TRIAGE_RESERVE_MS = 30_000;

function tally(metrics: Metrics, outcome: InsightOutcome, kind: string): Metrics {
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
      await pickBriefBatch(ctx.db, ctx.config.INTEL_UNIVERSE, BRIEFS_PER_FANOUT),
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
