import { sql } from "@ma/db";
import type { AppContext } from "../context";
import { cleanOrders, ORDER_FLOW_VERSION, type RawOrder } from "../orders/clean";
import { buildFlow, type OrderFlow } from "../orders/flow";
import { latestRevenueCr } from "./bot";

const MINUTE = 60_000;

export const ORDER_FLOW_MONTHS = [3, 6, 12, 24] as const;
export type OrderFlowMonths = (typeof ORDER_FLOW_MONTHS)[number];

async function rawOrders(ctx: AppContext, months: OrderFlowMonths): Promise<RawOrder[]> {
  const rows = await ctx.api.getOrLoad(
    `supply-chain:orderflow:v${ORDER_FLOW_VERSION}:raw:${months}`,
    () =>
      ctx.db.execute<{
        observation_id: number;
        announcement_id: number | null;
        family: string;
        published_at: string;
        supplier_symbol: string;
        supplier_name: string;
        buyer_name: string;
        buyer_kind: string;
        buyer_symbol: string | null;
        value_cr: string | null;
        currency: string | null;
        order_status: "awarded" | "pending" | "cancelled" | null;
        confidence: number;
        claim: string;
        subject: string | null;
        url: string;
      }>(sql`
        select o.id as observation_id, coalesce(a1.id, a2.id) as announcement_id,
               x.extractor_family as family, d.published_at::text as published_at,
               c.nse_symbol as supplier_symbol, c.name as supplier_name,
               cp.canonical_name as buyer_name, cp.kind as buyer_kind, bc.nse_symbol as buyer_symbol,
               o.value_cr::text as value_cr, o.currency, o.order_status, o.confidence, o.claim,
               coalesce(a1.subject, a2.subject) as subject,
               case when d.url like 'nse://%' then coalesce(a2.attachment_url, d.url) else d.url end as url
        from relationship_observations o
        join relationship_extractions x on x.id = o.extraction_id
        join documents d on d.current_revision_id = x.document_revision_id
        join companies c on c.id = o.focal_company_id and c.nse_symbol is not null
        join counterparties cp on cp.id = o.customer_counterparty_id
        left join companies bc on bc.id = cp.company_id
        left join announcements a1 on a1.attachment_url = d.url
        left join announcements a2 on a2.id = substring(d.url from '^nse://announcement/(\\d+)')::bigint
        where x.extractor_family in ('order_filing', 'announcement_metadata')
          and o.status in ('auto', 'confirmed', 'pending')
          and o.value_basis = 'contract_total'
          and d.published_at >= now() - make_interval(months => ${months})
          and d.published_at <= now()`),
    { ttlMs: 30 * MINUTE, staleMs: 6 * 60 * MINUTE },
  );
  return (rows ?? []).map((r) => ({
    observationId: Number(r.observation_id),
    announcementId: r.announcement_id == null ? null : Number(r.announcement_id),
    family: r.family,
    publishedAt: r.published_at,
    supplierSymbol: r.supplier_symbol,
    supplierName: r.supplier_name,
    buyerName: r.buyer_name,
    buyerKind: r.buyer_kind,
    buyerSymbol: r.buyer_symbol,
    valueCr: r.value_cr == null ? null : Number(r.value_cr),
    currency: r.currency,
    orderStatus: r.order_status,
    confidence: Number(r.confidence),
    claim: r.claim ?? "",
    subject: r.subject,
    url: r.url,
  }));
}

async function coverage(ctx: AppContext, months: OrderFlowMonths): Promise<OrderFlow["coverage"]> {
  const rows = await ctx.api.getOrLoad(
    `announcements:orderflow:v${ORDER_FLOW_VERSION}:coverage:${months}`,
    () =>
      ctx.db.execute<{ filings: number; read: number; companies: number }>(sql`
        with f as (
          select distinct on (regexp_replace(a.attachment_url, '^https?://[^/]+', ''))
                 a.id, a.company_id, regexp_replace(a.attachment_url, '^https?://[^/]+', '') as path
          from announcements a
          where a.category_key = 'order_win' and a.attachment_url is not null
            and a.published_at >= now() - make_interval(months => ${months})
            and a.published_at <= now()
          order by regexp_replace(a.attachment_url, '^https?://[^/]+', ''), a.id
        )
        select count(*)::int as filings,
               count(*) filter (where exists (
                 select 1 from documents d
                 where d.url in (
                   'https://nsearchives.nseindia.com' || f.path,
                   'https://nsearchives.nseindia.in' || f.path,
                   'https://archives.nseindia.com' || f.path,
                   'nse://announcement/' || f.id)))::int as read,
               count(distinct f.company_id)::int as companies
        from f`),
    { ttlMs: 30 * MINUTE, staleMs: 6 * 60 * MINUTE },
  );
  const r = rows?.[0];
  return r
    ? { filings: Number(r.filings), read: Number(r.read), companies: Number(r.companies) }
    : null;
}

export async function orderFlow(ctx: AppContext, months: OrderFlowMonths): Promise<OrderFlow> {
  const [raw, cov] = await Promise.all([
    rawOrders(ctx, months),
    coverage(ctx, months).catch(() => null),
  ]);
  const { orders, excluded } = cleanOrders(raw);
  const revenue = await latestRevenueCr(ctx, [...new Set(orders.map((o) => o.supplier))]);
  return { ...buildFlow(orders, excluded, revenue, months), coverage: cov };
}
