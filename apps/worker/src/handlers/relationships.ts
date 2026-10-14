import { DAY, MINUTE } from "@ma/core";
import { sql } from "@ma/db";
import {
  extractOrdersForCompany,
  extractRelationshipsForCompany,
  loadAliasMatcher,
  ORDER_ANNOUNCEMENT,
  ORDER_ANNOUNCEMENT_UNREAD,
  RELATIONSHIP_EXTRACTOR_VERSION,
  syncCounterparties,
  syncFundamentals,
} from "@ma/ingest";
import { DeferredError, pickBatch } from "@ma/jobs";
import { trackCompany } from "../batch.js";
import { companies, done, fanout, type HandlerMap } from "../registry.js";

const RELATIONSHIPS_PER_FANOUT = 6;
const ORDERS_PER_FANOUT = 80;
const ANNUAL_REPORTS = 2;
const CONCALLS = 4;
const RESUME_MS = MINUTE;

export const SOURCES_PENDING = sql`(s.synced_at is null or s.synced_at < now() - interval '1 day')
  and (not exists (
      select 1 from company_graph_state g
      where g.company_id = c.id and g.extractor_version >= ${RELATIONSHIP_EXTRACTOR_VERSION})
    or exists (
      select 1 from relationship_sources rs
      join documents d on d.id = rs.document_id
      where rs.company_id = c.id and rs.family in ('annual_report', 'concall', 'screener')
        and (rs.read_revision_id is null
          or rs.read_revision_id is distinct from d.current_revision_id
          or coalesce(rs.read_extractor_version, 0) < ${RELATIONSHIP_EXTRACTOR_VERSION})
        and (rs.family <> 'screener' or rs.last_read_at is null
          or rs.last_read_at < now() - interval '30 days')))`;

export const ORDERS_PENDING = sql`exists (
  select 1 from announcements a
  where a.company_id = c.id and ${ORDER_ANNOUNCEMENT} and ${ORDER_ANNOUNCEMENT_UNREAD})`;

const NON_FINANCIAL = sql`c.industry !~* 'bank|financ|insurance'`;

type RelationshipHandlers = Pick<
  HandlerMap,
  | "relationships.fanout"
  | "relationships.extract"
  | "relationships.counterparties"
  | "relationships.rebuild"
  | "orders.fanout"
  | "orders.extract"
>;

function resumeLater(remaining: number): DeferredError {
  return new DeferredError(new Date(Date.now() + RESUME_MS), `${remaining} documents remaining`);
}

export const relationshipHandlers: RelationshipHandlers = {
  "relationships.fanout": async ({ ctx }) =>
    companies(
      "relationships.extract",
      await pickBatch(ctx.db, "relationships", ctx.config.DATA_UNIVERSE, RELATIONSHIPS_PER_FANOUT, {
        maxAgeMs: 14 * DAY,
        due: SOURCES_PENDING,
        where: NON_FINANCIAL,
      }),
    ),
  "relationships.extract": async (run) => {
    const { ctx, payload, signal } = run;
    const r = await trackCompany(
      run,
      "relationships",
      payload.companyId,
      async () => {
        const f = await syncFundamentals(ctx, payload.companyId, signal);
        if (!f) return null;
        const sources = [
          ...f.annualReports
            .slice(0, ANNUAL_REPORTS)
            .map((a) => ({ ...a, kind: "annual_report" as const })),
          ...f.concalls.slice(0, CONCALLS).map((c) => ({ ...c, kind: "concall" as const })),
        ];
        const matcher = await loadAliasMatcher(ctx);
        return extractRelationshipsForCompany(ctx, payload.companyId, sources, matcher, signal, {
          force: payload.force ?? false,
        });
      },
      (result) => result === null || result.remaining === 0,
    );
    if (!r) return done({ missing: 1 });
    if (r.remaining > 0) throw resumeLater(r.remaining);
    return done({
      documents: r.documents,
      skipped: r.skipped,
      failed: r.failed,
      observations: r.observations,
      relationships: r.relationships,
    });
  },
  "relationships.counterparties": async ({ ctx, signal }) => {
    const r = await syncCounterparties(ctx.db, signal);
    return done({ ...r });
  },
  "relationships.rebuild": async ({ ctx }) => {
    const rows = await ctx.db.execute<{ id: number }>(sql`
      select c.id from companies c
      where exists (
          select 1 from relationship_sources rs where rs.company_id = c.id and rs.family <> 'legacy')
        or exists (
          select 1 from documents d
          where d.company_id = c.id and d.source in ('annual_report', 'concall', 'screener'))
        or exists (
          select 1 from relationships r
          where r.status = 'legacy'
            and (r.supplier_company_id = c.id or r.customer_company_id = c.id))
      order by c.market_cap_cr desc nulls last`);
    return fanout(
      "relationships.extract",
      rows.map((r) => ({ companyId: Number(r.id), force: true })),
    );
  },
  "orders.fanout": async ({ ctx }) =>
    companies(
      "orders.extract",
      await pickBatch(ctx.db, "orders", ctx.config.DATA_UNIVERSE, ORDERS_PER_FANOUT, {
        where: ORDERS_PENDING,
      }),
    ),
  "orders.extract": async (run) => {
    const { ctx, payload, signal } = run;
    const r = await trackCompany(
      run,
      "orders",
      payload.companyId,
      async () =>
        extractOrdersForCompany(ctx, payload.companyId, await loadAliasMatcher(ctx), signal),
      (result) => result.remaining === 0,
    );
    if (r.remaining > 0) throw resumeLater(r.remaining);
    return done({
      announcements: r.announcements,
      documents: r.documents,
      failed: r.failed,
      observations: r.observations,
      relationships: r.relationships,
    });
  },
};
