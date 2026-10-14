import { isoDate, sha256, throwIfAborted } from "@ma/core";
import { and, type Db, eq, fencedBatches, inArray, relationshipEstimates, sql } from "@ma/db";
import type { CostBucket, ValueBasis } from "@ma/ingest";
import { loadPriors, PRIOR_MODEL_VERSION, type Prior, priorFor } from "./priors.js";

export const ESTIMATE_MODEL_VERSION = 2;
export const MAX_AGGREGATE_SHARE_PCT = 100;

type Method = (typeof relationshipEstimates.$inferInsert)["method"];

export interface AnnualFinancials {
  periodEnd: string;
  revenue: number | null;
  cogs: number | null;
  purchases: number | null;
  capex: number | null;
  sga: number | null;
  rnd: number | null;
}

export interface EstimateEdge {
  id: number;
  supplierCompanyId: number | null;
  customerCompanyId: number | null;
  supplierSector: string | null;
  costBucket: CostBucket;
  valueBasis: ValueBasis;
  disclosedPct: number | null;
  disclosedValue: number | null;
  fiscalYear: number | null;
  cueClass: string;
  inUniverse: boolean;
}

export interface Estimate {
  relationshipId: number;
  customerCompanyId: number | null;
  costBucket: CostBucket;
  method: Method;
  valueBasis: ValueBasis;
  periodStart: string | null;
  periodEnd: string | null;
  valueCr: number | null;
  valueLowCr: number | null;
  valueHighCr: number | null;
  supplierRevenuePct: number | null;
  customerCostPct: number | null;
  inputs: Record<string, unknown>;
}

const round2 = (v: number): number => Math.round(v * 100) / 100;

export function fiscalYearOf(day: string): number {
  const year = Number(day.slice(0, 4));
  return Number(day.slice(5, 7)) >= 4 ? year + 1 : year;
}

function periodOf(
  fins: readonly AnnualFinancials[],
  fiscalYear: number | null,
  has: (f: AnnualFinancials) => number | null,
): AnnualFinancials | null {
  const usable = fins.filter((f) => has(f) !== null && (has(f) as number) > 0);
  if (fiscalYear === null) return usable.at(-1) ?? null;
  return usable.find((f) => fiscalYearOf(f.periodEnd) === fiscalYear) ?? null;
}

function costBase(f: AnnualFinancials, bucket: CostBucket): number | null {
  if (bucket === "CAPEX") return f.capex;
  if (bucket === "SGA") return f.sga;
  if (bucket === "RND") return f.rnd;
  return f.purchases ?? f.cogs;
}

function pctOf(value: number | null, base: number | null): number | null {
  return value === null || base === null || base <= 0 ? null : round2((value / base) * 100);
}

function startOf(periodEnd: string | null): string | null {
  if (!periodEnd) return null;
  const d = new Date(`${periodEnd}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() - 1);
  d.setUTCDate(d.getUTCDate() + 1);
  return isoDate(d);
}

export function estimateRelationship(
  edge: EstimateEdge,
  supplierFins: readonly AnnualFinancials[],
  customerFins: readonly AnnualFinancials[],
  priors: ReadonlyMap<string, Prior>,
): Estimate[] {
  const fy = edge.fiscalYear;
  const inputs: Record<string, unknown> = {
    modelVersion: ESTIMATE_MODEL_VERSION,
    valueBasis: edge.valueBasis,
    costBucket: edge.costBucket,
    cueClass: edge.cueClass,
    disclosedPct: edge.disclosedPct,
    disclosedValue: edge.disclosedValue,
    fiscalYear: fy,
  };
  const row = (
    method: Method,
    valueBasis: ValueBasis,
    period: string | null,
    values: Partial<
      Pick<
        Estimate,
        "valueCr" | "valueLowCr" | "valueHighCr" | "supplierRevenuePct" | "customerCostPct"
      >
    >,
    extra: Record<string, unknown> = {},
  ): Estimate => ({
    relationshipId: edge.id,
    customerCompanyId: edge.customerCompanyId,
    costBucket: edge.costBucket,
    method,
    valueBasis,
    periodStart: startOf(period),
    periodEnd: period,
    valueCr: values.valueCr ?? null,
    valueLowCr: values.valueLowCr ?? values.valueCr ?? null,
    valueHighCr: values.valueHighCr ?? values.valueCr ?? null,
    supplierRevenuePct: values.supplierRevenuePct ?? null,
    customerCostPct: values.customerCostPct ?? null,
    inputs: { ...inputs, ...extra },
  });
  const customerShare = (value: number | null, periodFy: number | null) => {
    const f = periodOf(customerFins, periodFy, (x) => costBase(x, edge.costBucket));
    return pctOf(value, f ? costBase(f, edge.costBucket) : null);
  };
  const supplierShare = (value: number | null, periodFy: number | null) => {
    const f = periodOf(supplierFins, periodFy, (x) => x.revenue);
    return pctOf(value, f?.revenue ?? null);
  };

  if (edge.valueBasis === "contract_total") {
    const contract =
      edge.disclosedValue === null
        ? []
        : [
            row(
              "disclosed",
              "contract_total",
              null,
              { valueCr: round2(edge.disclosedValue) },
              { source: "contract_total" },
            ),
          ];
    return [...contract, ...statistical()];
  }

  if (edge.valueBasis === "annual_flow" && edge.disclosedValue !== null) {
    const value = round2(edge.disclosedValue);
    const period = fy === null ? null : `${fy}-03-31`;
    return [
      row("disclosed", "annual_flow", period, {
        valueCr: value,
        supplierRevenuePct: supplierShare(value, fy),
        customerCostPct: customerShare(value, fy),
      }),
    ];
  }

  if (edge.valueBasis === "revenue_share" && edge.disclosedPct !== null) {
    const f = periodOf(supplierFins, fy, (x) => x.revenue);
    if (!f?.revenue) {
      return [
        row(
          "disclosed",
          "revenue_share",
          null,
          { supplierRevenuePct: edge.disclosedPct },
          { reason: "no_supplier_revenue_for_period" },
        ),
      ];
    }
    const value = round2((f.revenue * edge.disclosedPct) / 100);
    const periodFy = fiscalYearOf(f.periodEnd);
    return [
      row(
        "disclosed",
        "revenue_share",
        f.periodEnd,
        {
          valueCr: value,
          supplierRevenuePct: edge.disclosedPct,
          customerCostPct: customerShare(value, periodFy),
        },
        { denominator: "supplier_revenue", denominatorCr: f.revenue },
      ),
    ];
  }

  if (edge.valueBasis === "purchase_share" && edge.disclosedPct !== null) {
    const f = periodOf(customerFins, fy, (x) => costBase(x, edge.costBucket));
    const base = f ? costBase(f, edge.costBucket) : null;
    if (!f || base === null) {
      return [
        row(
          "derived",
          "purchase_share",
          null,
          { customerCostPct: edge.disclosedPct },
          { reason: "no_customer_cost_base_for_period" },
        ),
      ];
    }
    const value = round2((base * edge.disclosedPct) / 100);
    const periodFy = fiscalYearOf(f.periodEnd);
    return [
      row(
        "derived",
        "purchase_share",
        f.periodEnd,
        {
          valueCr: value,
          supplierRevenuePct: supplierShare(value, periodFy),
          customerCostPct: edge.disclosedPct,
        },
        { denominator: "customer_cost_base", denominatorCr: base },
      ),
    ];
  }

  return statistical();

  function statistical(): Estimate[] {
    if (!edge.inUniverse) {
      return [row("estimated", "annual_flow", null, {}, { reason: "outside_universe" })];
    }
    const prior = priorFor(priors, edge.supplierSector, edge.costBucket, edge.cueClass);
    if (!prior) {
      return [row("estimated", "annual_flow", null, {}, { reason: "insufficient_prior" })];
    }
    const priorInputs = {
      prior: {
        modelVersion: PRIOR_MODEL_VERSION,
        sector: prior.supplierSector,
        costBucket: prior.costBucket,
        cueClass: prior.cueClass,
        disclosures: prior.disclosures,
        suppliers: prior.suppliers,
        p25: prior.shareP25,
        p50: prior.shareP50,
        p75: prior.shareP75,
      },
    };
    const f = periodOf(supplierFins, null, (x) => x.revenue);
    if (!f?.revenue) {
      return [
        row(
          "estimated",
          "annual_flow",
          null,
          { supplierRevenuePct: prior.shareP50 },
          { ...priorInputs, reason: "no_supplier_revenue" },
        ),
      ];
    }
    const value = round2((f.revenue * prior.shareP50) / 100);
    return [
      row(
        "estimated",
        "annual_flow",
        f.periodEnd,
        {
          valueCr: value,
          valueLowCr: round2((f.revenue * prior.shareP25) / 100),
          valueHighCr: round2((f.revenue * prior.shareP75) / 100),
          supplierRevenuePct: prior.shareP50,
          customerCostPct: customerShare(value, fiscalYearOf(f.periodEnd)),
        },
        { ...priorInputs, denominator: "supplier_revenue", denominatorCr: f.revenue },
      ),
    ];
  }
}

export function applyAggregateCaps(estimates: readonly Estimate[]): Estimate[] {
  const groups = new Map<string, Estimate[]>();
  for (const e of estimates) {
    if (e.valueBasis === "contract_total" || e.customerCompanyId === null) continue;
    if (e.customerCostPct === null || e.valueCr === null) continue;
    const key = `${e.customerCompanyId}|${e.costBucket}|${e.periodEnd ?? ""}`;
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }
  const scaled = new Map<Estimate, number>();
  for (const rows of groups.values()) {
    const fixed = rows
      .filter((r) => r.method !== "estimated")
      .reduce((s, r) => s + (r.customerCostPct as number), 0);
    const stat = rows.filter((r) => r.method === "estimated");
    const statTotal = stat.reduce((s, r) => s + (r.customerCostPct as number), 0);
    if (!statTotal || fixed + statTotal <= MAX_AGGREGATE_SHARE_PCT) continue;
    const scale = Math.max(0, MAX_AGGREGATE_SHARE_PCT - fixed) / statTotal;
    for (const r of stat) scaled.set(r, scale);
  }
  return estimates.map((e) => {
    const scale = scaled.get(e);
    if (scale === undefined) return e;
    const by = (v: number | null) => (v === null ? null : round2(v * scale));
    return {
      ...e,
      valueCr: by(e.valueCr),
      valueLowCr: by(e.valueLowCr),
      valueHighCr: by(e.valueHighCr),
      supplierRevenuePct: by(e.supplierRevenuePct),
      customerCostPct: by(e.customerCostPct),
      inputs: { ...e.inputs, aggregateCapScale: round2(scale * 10_000) / 10_000 },
    };
  });
}

export function estimateInputsHash(e: Estimate): string {
  return sha256(
    JSON.stringify([
      e.method,
      e.valueBasis,
      e.periodEnd,
      e.valueCr,
      e.valueLowCr,
      e.valueHighCr,
      e.supplierRevenuePct,
      e.customerCostPct,
      e.inputs,
    ]),
  );
}

async function loadEdges(db: Db, asOf: string, universe: string): Promise<EstimateEdge[]> {
  const rows = await db.execute<{
    id: number;
    supplier_company_id: number | null;
    customer_company_id: number | null;
    supplier_sector: string | null;
    cost_bucket: CostBucket;
    value_basis: ValueBasis;
    disclosed_pct: number | null;
    disclosed_value: string | null;
    fiscal_year: number | null;
    cue_class: string | null;
    in_universe: boolean;
  }>(sql`
    with members as (
      select ic.company_id from index_constituents ic
      join indices i on i.id = ic.index_id and i.code = ${universe}
    )
    select r.id, r.supplier_company_id, r.customer_company_id, sc.sector as supplier_sector,
      r.cost_bucket, r.value_basis, r.disclosed_pct, r.disclosed_value::text as disclosed_value,
      r.fiscal_year, cue.cue_class,
      (r.supplier_company_id in (select company_id from members)
        or r.customer_company_id in (select company_id from members)) as in_universe
    from relationships r
    left join companies sc on sc.id = r.supplier_company_id
    left join lateral (
      select o.cue_class from relationship_observations o
      where o.supplier_counterparty_id = r.supplier_counterparty_id
        and o.customer_counterparty_id = r.customer_counterparty_id
        and o.cost_bucket = r.cost_bucket and o.status in ('pending', 'auto', 'confirmed')
        and o.cue_class not in ('revenue_share', 'purchase_share')
      order by case o.cue_class when 'order' then 1 when 'customer_count' then 2
        when 'ownership' then 3 else 4 end
      limit 1
    ) cue on true
    where r.status = 'active' and r.valid_from <= ${asOf} and r.valid_to >= ${asOf}
    order by r.id`);
  return rows.map((r) => ({
    id: Number(r.id),
    supplierCompanyId: r.supplier_company_id === null ? null : Number(r.supplier_company_id),
    customerCompanyId: r.customer_company_id === null ? null : Number(r.customer_company_id),
    supplierSector: r.supplier_sector,
    costBucket: r.cost_bucket,
    valueBasis: r.value_basis,
    disclosedPct: r.disclosed_pct === null ? null : Number(r.disclosed_pct),
    disclosedValue: r.disclosed_value === null ? null : Number(r.disclosed_value),
    fiscalYear: r.fiscal_year === null ? null : Number(r.fiscal_year),
    cueClass: r.cue_class ?? "mention",
    inUniverse: r.in_universe === true,
  }));
}

export async function annualFinancials(
  db: Db,
  companyIds: readonly number[],
  asOf: string,
): Promise<Map<number, AnnualFinancials[]>> {
  const out = new Map<number, AnnualFinancials[]>();
  if (!companyIds.length) return out;
  const ids = sql.join(
    companyIds.map((id) => sql`${id}`),
    sql`, `,
  );
  const rows = await db.execute<{
    company_id: number;
    period_end: string;
    revenue: string | null;
    cogs: string | null;
    purchases: string | null;
    capex: string | null;
    sga: string | null;
    rnd: string | null;
  }>(sql`
    with facts as (
      select company_id, period_end,
        max(value_cr) filter (where metric = 'revenue') as revenue,
        max(value_cr) filter (where metric = 'cogs') as cogs,
        max(value_cr) filter (where metric = 'purchases') as purchases,
        max(value_cr) filter (where metric = 'capex') as capex,
        max(value_cr) filter (where metric = 'sga') as sga,
        max(value_cr) filter (where metric = 'rnd') as rnd
      from relationship_financial_facts
      where company_id in (${ids}) and period_type = 'annual' and period_end <= ${asOf}
      group by company_id, period_end
    ), funds as (
      select company_id, period_end, revenue, cogs, null::numeric as purchases, capex, sga, rnd
      from fundamentals
      where company_id in (${ids}) and period_type = 'annual' and period_end <= ${asOf}
    )
    select coalesce(x.company_id, f.company_id) as company_id,
      coalesce(x.period_end, f.period_end)::text as period_end,
      coalesce(x.revenue, f.revenue)::text as revenue, coalesce(x.cogs, f.cogs)::text as cogs,
      x.purchases::text as purchases, coalesce(x.capex, f.capex)::text as capex,
      coalesce(x.sga, f.sga)::text as sga, coalesce(x.rnd, f.rnd)::text as rnd
    from facts x
    full join funds f on f.company_id = x.company_id and f.period_end = x.period_end
    order by 1, 2`);
  const num = (v: string | null) => (v === null ? null : Number(v));
  for (const r of rows) {
    const id = Number(r.company_id);
    const list = out.get(id) ?? [];
    list.push({
      periodEnd: r.period_end,
      revenue: num(r.revenue),
      cogs: num(r.cogs),
      purchases: num(r.purchases),
      capex: num(r.capex),
      sga: num(r.sga),
      rnd: num(r.rnd),
    });
    out.set(id, list);
  }
  return out;
}

export async function refreshEstimates(
  db: Db,
  asOf: string,
  universe: string,
  signal?: AbortSignal,
): Promise<number> {
  const edges = await loadEdges(db, asOf, universe);
  const ids = new Set<number>();
  for (const e of edges) {
    if (e.supplierCompanyId !== null) ids.add(e.supplierCompanyId);
    if (e.customerCompanyId !== null) ids.add(e.customerCompanyId);
  }
  const [fins, priors] = await Promise.all([annualFinancials(db, [...ids], asOf), loadPriors(db)]);
  const finsOf = (id: number | null) => (id === null ? [] : (fins.get(id) ?? []));
  const raw: Estimate[] = [];
  for (const edge of edges) {
    throwIfAborted(signal);
    raw.push(
      ...estimateRelationship(
        edge,
        finsOf(edge.supplierCompanyId),
        finsOf(edge.customerCompanyId),
        priors,
      ),
    );
  }
  const byRelationship = new Map<number, (typeof relationshipEstimates.$inferInsert)[]>();
  for (const e of applyAggregateCaps(raw)) {
    const list = byRelationship.get(e.relationshipId) ?? [];
    list.push({
      relationshipId: e.relationshipId,
      asOf,
      method: e.method,
      valueBasis: e.valueBasis,
      periodStart: e.periodStart,
      periodEnd: e.periodEnd,
      valueCr: e.valueCr?.toString() ?? null,
      valueLowCr: e.valueLowCr?.toString() ?? null,
      valueHighCr: e.valueHighCr?.toString() ?? null,
      supplierRevenuePct: e.supplierRevenuePct,
      customerCostPct: e.customerCostPct,
      inputs: e.inputs,
      inputsHash: estimateInputsHash(e),
      modelVersion: ESTIMATE_MODEL_VERSION,
    });
    byRelationship.set(e.relationshipId, list);
  }
  await fencedBatches(
    db,
    [...byRelationship.entries()],
    async (tx, groups) => {
      await tx.delete(relationshipEstimates).where(
        and(
          eq(relationshipEstimates.asOf, asOf),
          eq(relationshipEstimates.modelVersion, ESTIMATE_MODEL_VERSION),
          inArray(
            relationshipEstimates.relationshipId,
            groups.map(([id]) => id),
          ),
        ),
      );
      await tx.insert(relationshipEstimates).values(groups.flatMap(([, rows]) => rows));
    },
    { size: 100, signal: signal ?? null },
  );
  return raw.length;
}
