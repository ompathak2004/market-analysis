import { DAY } from "@ma/core";
import { sql } from "@ma/db";
import {
  extractRelationshipsForCompany,
  loadAliasMatcher,
  RELATIONSHIP_EXTRACTOR_VERSION,
  syncFundamentals,
} from "@ma/ingest";
import { pickBatch } from "@ma/jobs";
import { trackCompany } from "../batch.js";
import { companies, done, type HandlerMap } from "../registry.js";

const RELATIONSHIPS_PER_FANOUT = 6;
const ANNUAL_REPORTS = 2;
const CONCALLS = 4;

// Only the documents extract actually reads (the newest ANNUAL_REPORTS and CONCALLS per company)
// can make a company due; older ones stay below the extractor version forever and would otherwise
// reselect the company on every fan-out.
export const DOCUMENTS_PENDING = sql`exists (
  select 1 from (
    select d.fetched_at, d.parser_version,
      row_number() over (partition by d.source order by d.fetched_at desc, d.id desc) as rn,
      d.source
    from documents d
    where d.company_id = c.id and d.source in ('annual_report', 'concall')
  ) d
  where ((d.source = 'annual_report' and d.rn <= ${ANNUAL_REPORTS})
      or (d.source = 'concall' and d.rn <= ${CONCALLS}))
    and (s.synced_at is null or d.fetched_at > s.synced_at
      or (coalesce(d.parser_version, 0) < ${RELATIONSHIP_EXTRACTOR_VERSION}
        and s.synced_at < now() - interval '1 day')))`;

type RelationshipHandlers = Pick<HandlerMap, "relationships.fanout" | "relationships.extract">;

export const relationshipHandlers: RelationshipHandlers = {
  "relationships.fanout": async ({ ctx }) =>
    companies(
      "relationships.extract",
      await pickBatch(ctx.db, "relationships", ctx.config.DATA_UNIVERSE, RELATIONSHIPS_PER_FANOUT, {
        maxAgeMs: 14 * DAY,
        due: DOCUMENTS_PENDING,
        where: sql`c.industry !~* 'bank|financ|insurance'`,
      }),
    ),
  "relationships.extract": async (run) => {
    const { ctx, payload, signal } = run;
    return trackCompany(run, "relationships", payload.companyId, async () => {
      const f = await syncFundamentals(ctx, payload.companyId, signal);
      if (!f) return done({ missing: 1 });
      const sources = [
        ...f.annualReports
          .slice(0, ANNUAL_REPORTS)
          .map((a) => ({ ...a, kind: "annual_report" as const })),
        ...f.concalls.slice(0, CONCALLS).map((c) => ({ ...c, kind: "concall" as const })),
      ];
      const matcher = await loadAliasMatcher(ctx);
      const r = await extractRelationshipsForCompany(
        ctx,
        payload.companyId,
        sources,
        matcher,
        signal,
      );
      return done({ documents: r.documents, relationships: r.relationships });
    });
  },
};
