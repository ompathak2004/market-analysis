import { DAY } from "@ma/core";
import { EgazetteSource } from "@ma/ingest";
import {
  affidavitTargets,
  seedCompanyPolicySectors,
  syncAffidavit,
  syncBonds,
  syncGazette,
  syncGovernance,
  syncParliament,
  syncPerimeter,
  syncPib,
  syncPrs,
  syncRelatedParties,
  tagPolicyEvent,
  untaggedPolicyEvents,
} from "@ma/intel";
import { pickBatch } from "@ma/jobs";
import { numericMetrics, trackCompany } from "../batch.js";
import { companies, done, fanout, type HandlerMap } from "../registry.js";

const INFLUENCE_PER_FANOUT = 120;
const INFLUENCE_MAX_AGE_MS = 6 * DAY;
const AFFIDAVITS_PER_FANOUT = 100;
const POLICY_TAGS_PER_FANOUT = 60;

type InfluenceHandlers = Pick<
  HandlerMap,
  | "influence.governance.fanout"
  | "influence.governance"
  | "influence.rpt.fanout"
  | "influence.rpt"
  | "influence.perimeter.fanout"
  | "influence.perimeter"
  | "influence.parliament"
  | "influence.affidavits"
  | "influence.affidavit"
  | "influence.bonds"
  | "influence.policy.pib"
  | "influence.policy.gazette"
  | "influence.policy.prs"
  | "influence.sectors"
  | "influence.policy.tag"
  | "influence.policy.tag.event"
>;

export const influenceHandlers: InfluenceHandlers = {
  "influence.governance.fanout": async ({ ctx }) =>
    companies(
      "influence.governance",
      await pickBatch(
        ctx.db,
        "influence_governance",
        ctx.config.INTEL_UNIVERSE,
        INFLUENCE_PER_FANOUT,
        {
          maxAgeMs: INFLUENCE_MAX_AGE_MS,
        },
      ),
    ),
  "influence.governance": async (run) => {
    const { ctx, payload, signal } = run;
    const r = await trackCompany(run, "influence_governance", payload.companyId, () =>
      syncGovernance(ctx, payload.companyId, { signal }),
    );
    return done({ ...numericMetrics(r), [r.status]: 1 });
  },
  "influence.rpt.fanout": async ({ ctx }) =>
    companies(
      "influence.rpt",
      await pickBatch(ctx.db, "influence_rpt", ctx.config.INTEL_UNIVERSE, INFLUENCE_PER_FANOUT, {
        maxAgeMs: INFLUENCE_MAX_AGE_MS,
      }),
    ),
  "influence.rpt": async (run) => {
    const { ctx, payload, signal } = run;
    const r = await trackCompany(run, "influence_rpt", payload.companyId, () =>
      syncRelatedParties(ctx, payload.companyId, { signal }),
    );
    return done({ ...numericMetrics(r), [r.status]: 1 });
  },
  "influence.perimeter.fanout": async ({ ctx }) =>
    companies(
      "influence.perimeter",
      await pickBatch(
        ctx.db,
        "influence_perimeter",
        ctx.config.INTEL_UNIVERSE,
        INFLUENCE_PER_FANOUT,
        {
          maxAgeMs: INFLUENCE_MAX_AGE_MS,
        },
      ),
    ),
  "influence.perimeter": async (run) => {
    const { ctx, payload, signal } = run;
    const r = await trackCompany(run, "influence_perimeter", payload.companyId, () =>
      syncPerimeter(ctx, payload.companyId, signal),
    );
    return done(numericMetrics(r));
  },
  "influence.parliament": async ({ ctx, signal }) => {
    const r = await syncParliament(ctx, { signal });
    const metrics = { ...numericMetrics(r), [r.status]: 1 };
    return r.created > 0
      ? { metrics, children: [{ type: "influence.affidavits", payload: {} }] }
      : done(metrics);
  },
  "influence.affidavits": async ({ ctx, signal }) =>
    fanout(
      "influence.affidavit",
      (await affidavitTargets(ctx, { signal, limit: AFFIDAVITS_PER_FANOUT })).map((t) => ({
        ...t,
      })),
    ),
  "influence.affidavit": async ({ ctx, payload, signal }) => {
    const r = await syncAffidavit(ctx, payload, { signal });
    return done({ ...numericMetrics(r), [r.status]: 1 });
  },
  "influence.bonds": async ({ ctx, payload, signal }) => {
    const r = await syncBonds(ctx, payload, { signal });
    return done({ ...numericMetrics(r), [r.status]: 1 });
  },
  "influence.policy.pib": async ({ ctx, signal }) => done({ ...(await syncPib(ctx, { signal })) }),
  "influence.policy.gazette": async ({ ctx, payload, signal }) => {
    const urls = payload.urls ?? [];
    if (urls.length) return done({ ...(await syncGazette(ctx, urls, { signal })) });
    return done({ reachable: (await new EgazetteSource(ctx.http).reachable(signal)) ? 1 : 0 });
  },
  "influence.policy.prs": async ({ ctx, signal }) => done({ ...(await syncPrs(ctx, { signal })) }),
  "influence.sectors": async ({ ctx, signal }) =>
    done({ ...(await seedCompanyPolicySectors(ctx, signal)) }),
  "influence.policy.tag": async ({ ctx }) => {
    const remaining = ctx.llm.budget
      ? await ctx.llm.budget.remainingToday("influence")
      : Number.POSITIVE_INFINITY;
    if (remaining <= 0) return done({ budgetExhausted: 1 });
    return fanout(
      "influence.policy.tag.event",
      (await untaggedPolicyEvents(ctx, POLICY_TAGS_PER_FANOUT)).map((policyEventId) => ({
        policyEventId,
      })),
    );
  },
  "influence.policy.tag.event": async ({ ctx, payload, signal }) => {
    const r = await tagPolicyEvent(ctx, payload.policyEventId, { signal, llm: ctx.llm });
    return done({ ...numericMetrics(r), [r.status]: 1 });
  },
};
