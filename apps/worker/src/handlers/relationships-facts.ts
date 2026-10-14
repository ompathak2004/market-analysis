import { FINANCIAL_FACTS_PENDING, syncFinancialFacts } from "@ma/ingest";
import { pickBatch } from "@ma/jobs";
import { trackCompany } from "../batch.js";
import { companies, done, type HandlerMap } from "../registry.js";

const FACTS_PER_FANOUT = 100;

export const relationshipFactHandlers: Pick<
  HandlerMap,
  "relationships.facts.fanout" | "relationships.facts"
> = {
  "relationships.facts.fanout": async ({ ctx }) =>
    companies(
      "relationships.facts",
      await pickBatch(ctx.db, "financial_facts", ctx.config.INTEL_UNIVERSE, FACTS_PER_FANOUT, {
        where: FINANCIAL_FACTS_PENDING,
      }),
    ),
  "relationships.facts": async (run) => {
    const { ctx, payload, signal } = run;
    const r = await trackCompany(run, "financial_facts", payload.companyId, () =>
      syncFinancialFacts(ctx, payload.companyId, signal),
    );
    return done({ ...r });
  },
};
