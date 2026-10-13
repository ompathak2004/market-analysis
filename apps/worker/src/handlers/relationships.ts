import { DAY } from "@ma/core";
import { sql } from "@ma/db";
import { extractRelationshipsForCompany, loadAliasMatcher, syncFundamentals } from "@ma/ingest";
import { pickBatch, trackCompany } from "../batch.js";
import { companies, done, type HandlerMap } from "../registry.js";

const RELATIONSHIPS_PER_FANOUT = 6;
const ANNUAL_REPORTS = 2;
const CONCALLS = 4;

type RelationshipHandlers = Pick<HandlerMap, "relationships.fanout" | "relationships.extract">;

export const relationshipHandlers: RelationshipHandlers = {
  "relationships.fanout": async ({ ctx }) =>
    companies(
      "relationships.extract",
      await pickBatch(ctx.db, "relationships", ctx.config.DATA_UNIVERSE, RELATIONSHIPS_PER_FANOUT, {
        maxAgeMs: 14 * DAY,
        where: sql`c.industry !~* 'bank|financ|insurance'`,
      }),
    ),
  "relationships.extract": async ({ ctx, payload }) =>
    trackCompany(ctx.db, "relationships", payload.companyId, async () => {
      const f = await syncFundamentals(ctx, payload.companyId);
      if (!f) return done({ missing: 1 });
      const sources = [
        ...f.annualReports
          .slice(0, ANNUAL_REPORTS)
          .map((a) => ({ ...a, kind: "annual_report" as const })),
        ...f.concalls.slice(0, CONCALLS).map((c) => ({ ...c, kind: "concall" as const })),
      ];
      const matcher = await loadAliasMatcher(ctx);
      const r = await extractRelationshipsForCompany(ctx, payload.companyId, sources, matcher);
      return done({ documents: r.documents, relationships: r.relationships });
    }),
};
