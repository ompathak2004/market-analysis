import { sql } from "@ma/db";
import type { AppContext } from "../context";
import type { InfluenceEvidence } from "./influence";

export type RegionalExposure = {
  key: string;
  facilityId: number | null;
  facility: string;
  role: string;
  siteAsOf: string | null;
  stateCode: string | null;
  jurisdictionSourceUrl: string | null;
  stateName: string | null;
  headName: string | null;
  observedOn: string | null;
  sourceReviewedOn: string | null;
  freshness: "recent" | "stale" | "unavailable";
  evidence: InfluenceEvidence[];
};

export async function regionalExposure(
  ctx: Pick<AppContext, "db">,
  companyId: number,
): Promise<RegionalExposure[]> {
  const rows = await ctx.db.execute<RegionalExposure>(sql`
    with sites as (
      select 'facility:' || f.id as key, f.id as facility_id, f.name as facility, fc.role::text as role,
        f.state_code, f.jurisdiction_source_url, null::bigint as evidence_span_id, null::date as site_as_of
      from facility_companies fc join facilities f on f.id = fc.facility_id
      where fc.company_id = ${companyId} and f.active and f.kind <> 'hq'
      union all
      select 'site:' || s.document_id || ':' || s.name, null::int, s.name, 'disclosed operation',
        s.state_code, d.url, s.evidence_span_id, s.observed_on
      from company_operating_sites s join documents d on d.id = s.document_id
      join evidence_spans se on se.id = s.evidence_span_id
      where s.company_id = ${companyId} and se.document_revision_id = d.current_revision_id
    )
    select f.key, f.facility_id as "facilityId", f.facility, f.role, f.site_as_of as "siteAsOf",
      f.state_code as "stateCode", f.jurisdiction_source_url as "jurisdictionSourceUrl",
      s.state_name as "stateName", s.head_name as "headName", s.observed_on as "observedOn",
      s.source_reviewed_on as "sourceReviewedOn",
      case when s.state_code is null then 'unavailable'
        when least(s.observed_on, coalesce(s.source_reviewed_on, s.observed_on)) < current_date - 30 then 'stale'
        else 'recent' end as freshness,
      (case when e.id is null then '[]'::jsonb else jsonb_build_array(jsonb_build_object(
        'spanId', e.id, 'quote', e.quote, 'page', e.page, 'documentId', d.id,
        'source', d.source, 'url', d.url, 'publishedAt', r.published_at)) end ||
      case when se.id is null then '[]'::jsonb else jsonb_build_array(jsonb_build_object(
        'spanId', se.id, 'quote', se.quote, 'page', se.page, 'documentId', sd.id,
        'source', sd.source, 'url', sd.url, 'publishedAt', sr.published_at)) end) as evidence
    from sites f
    left join lateral (select * from state_leadership h where h.state_code = f.state_code
      and h.observed_on = (select max(observed_on) from state_leadership where observed_on <= current_date)
      order by h.observed_on desc limit 1) s on true
    left join evidence_spans e on e.id = s.evidence_span_id
    left join document_revisions r on r.id = e.document_revision_id
    left join documents d on d.id = r.document_id
    left join evidence_spans se on se.id = f.evidence_span_id
    left join document_revisions sr on sr.id = se.document_revision_id
    left join documents sd on sd.id = sr.document_id
    order by f.state_code, f.facility`);
  return [...rows];
}
