import { HOUR, MINUTE } from "@ma/core";
import {
  PRESENTATIONS_PENDING,
  RATINGS_PENDING,
  syncLatestPresentation,
  syncRatingRationales,
} from "@ma/ingest";
import {
  extractLlmDocument,
  isLlmSourceName,
  LLM_SOURCE_NAMES,
  LLM_SOURCES,
  loadLlmDocument,
  pendingLlmPlan,
  refreshPriors,
} from "@ma/intel";
import { DeferredError, pickBatch } from "@ma/jobs";
import { trackCompany } from "../batch.js";
import { companies, done, fanout, type HandlerMap } from "../registry.js";

const LLM_DOCUMENTS_PER_SOURCE = 25;
const RATINGS_PER_FANOUT = 40;
const PRESENTATIONS_PER_FANOUT = 20;
const RESUME_MS = MINUTE;

type RelationshipLlmHandlers = Pick<
  HandlerMap,
  | "relationships.llm"
  | "relationships.llm.extract"
  | "relationships.priors"
  | "ratings.fanout"
  | "ratings.sync"
  | "presentations.fanout"
  | "presentations.sync"
>;

export const relationshipLlmHandlers: RelationshipLlmHandlers = {
  "relationships.llm": async ({ ctx }) => {
    const budget = ctx.llm.budget;
    const remaining = budget
      ? await budget.remainingToday("relationships")
      : Number.POSITIVE_INFINITY;
    const sources = LLM_SOURCE_NAMES.filter(
      (s) => s !== "presentation" || ctx.config.SPLC_PRESENTATIONS_PILOT,
    );
    const plan = await pendingLlmPlan(ctx.db, sources, LLM_DOCUMENTS_PER_SOURCE, remaining);
    return fanout(
      "relationships.llm.extract",
      plan.map((p) => ({ ...p })),
    );
  },
  "relationships.llm.extract": async ({ ctx, payload, signal }) => {
    if (!isLlmSourceName(payload.source)) return done({ unknownSource: 1 });
    const source = LLM_SOURCES[payload.source];
    const doc = await loadLlmDocument(ctx.db, source, payload.companyId, payload.documentId);
    if (!doc) return done({ missing: 1 });
    const r = await extractLlmDocument(ctx, source, doc, { signal });
    return done({
      [r.status]: 1,
      observations: r.observations,
      dropped: r.dropped,
      edges: r.edges,
      tokens: r.tokens,
    });
  },
  "relationships.priors": async ({ ctx, signal }) =>
    done({ ...(await refreshPriors(ctx.db, signal)) }),
  "ratings.fanout": async ({ ctx }) =>
    companies(
      "ratings.sync",
      await pickBatch(ctx.db, "ratings", ctx.config.DATA_UNIVERSE, RATINGS_PER_FANOUT, {
        maxAgeMs: 12 * HOUR,
        where: RATINGS_PENDING,
      }),
    ),
  "ratings.sync": async (run) => {
    const { ctx, payload, signal } = run;
    const r = await trackCompany(
      run,
      "ratings",
      payload.companyId,
      () => syncRatingRationales(ctx, payload.companyId, signal),
      (result) => result.remaining === 0,
    );
    if (r.remaining > 0) {
      throw new DeferredError(new Date(Date.now() + RESUME_MS), `${r.remaining} ratings remaining`);
    }
    return done({ announcements: r.announcements, documents: r.documents, failed: r.failed });
  },
  "presentations.fanout": async ({ ctx }) => {
    if (!ctx.config.SPLC_PRESENTATIONS_PILOT) return done({ disabled: 1 });
    return companies(
      "presentations.sync",
      await pickBatch(
        ctx.db,
        "presentations",
        ctx.config.INTEL_UNIVERSE,
        PRESENTATIONS_PER_FANOUT,
        { maxAgeMs: 12 * HOUR, where: PRESENTATIONS_PENDING },
      ),
    );
  },
  "presentations.sync": async (run) => {
    const { ctx, payload, signal } = run;
    if (!ctx.config.SPLC_PRESENTATIONS_PILOT) return done({ disabled: 1 });
    const r = await trackCompany(run, "presentations", payload.companyId, () =>
      syncLatestPresentation(ctx, payload.companyId, signal),
    );
    return done({ [r.status]: 1 });
  },
};
