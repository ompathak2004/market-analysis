import { isoDate, throwIfAborted } from "@ma/core";
import {
  and,
  type Db,
  desc,
  eq,
  fundamentals,
  gte,
  lte,
  relationshipEstimates,
  relationships,
  signals,
} from "@ma/db";

export const ESTIMATE_MODEL_VERSION = 1;

type Relationship = typeof relationships.$inferSelect;
type Method = (typeof relationshipEstimates.$inferInsert)["method"];

export interface Financials {
  periodEnd: string;
  revenue: number | null;
  cogs: number | null;
}

export interface Estimate {
  method: Method;
  valueCr: number | null;
  valueLowCr: number | null;
  valueHighCr: number | null;
  supplierRevenuePct: number | null;
  customerCostPct: number | null;
  inputs: Record<string, unknown>;
}

const MANDATORY_DISCLOSURE_PCT = 10;
const DEFAULT_MENTION_PCT = 4;
const PRESS_MENTION_PCT = 6;

export function estimateRelationship(
  rel: Pick<
    Relationship,
    "disclosedPct" | "disclosedValue" | "disclosureKind" | "evidence" | "confidence"
  >,
  supplier: Financials | null,
  customer: Financials | null,
  priors: { largestCustomerPct?: number | null } = {},
): Estimate {
  const supplierRevenue = supplier?.revenue ?? null;
  const customerCogs = customer?.cogs ?? null;
  const inputs: Record<string, unknown> = {
    supplierRevenueCr: supplierRevenue,
    supplierPeriodEnd: supplier?.periodEnd ?? null,
    customerCogsCr: customerCogs,
    customerPeriodEnd: customer?.periodEnd ?? null,
    disclosureKind: rel.disclosureKind,
  };

  if (rel.disclosedValue != null) {
    const value = Number(rel.disclosedValue);
    inputs.disclosedValueCr = value;
    return finish("disclosed", value, value, value, supplierRevenue, customerCogs, inputs);
  }

  if (rel.disclosedPct != null && supplierRevenue != null) {
    const value = (supplierRevenue * rel.disclosedPct) / 100;
    inputs.disclosedPct = rel.disclosedPct;
    return finish(
      "derived",
      value,
      value * 0.9,
      value * 1.1,
      supplierRevenue,
      customerCogs,
      inputs,
    );
  }

  if (supplierRevenue == null) {
    return {
      method: "estimated",
      valueCr: null,
      valueLowCr: null,
      valueHighCr: null,
      supplierRevenuePct: null,
      customerCostPct: null,
      inputs,
    };
  }

  const largest = /\b(largest|biggest|top|key|anchor|major)\s+(customer|client|oem)\b/i.test(
    rel.evidence ?? "",
  );
  let priorPct: number;
  if (largest && priors.largestCustomerPct != null) priorPct = priors.largestCustomerPct;
  else if (largest || rel.disclosureKind === "major_customer") priorPct = MANDATORY_DISCLOSURE_PCT;
  else if (rel.disclosureKind === "press") priorPct = PRESS_MENTION_PCT;
  else priorPct = DEFAULT_MENTION_PCT;
  inputs.priorPct = priorPct;
  inputs.priorBasis = largest ? "largest_customer_cue" : rel.disclosureKind;

  const spread = 1 - Math.min(0.9, Math.max(0.1, rel.confidence));
  const value = (supplierRevenue * priorPct) / 100;
  return finish(
    "estimated",
    value,
    value * (1 - spread),
    value * (1 + spread),
    supplierRevenue,
    customerCogs,
    inputs,
  );
}

function finish(
  method: Method,
  value: number,
  low: number,
  high: number,
  supplierRevenue: number | null,
  customerCogs: number | null,
  inputs: Record<string, unknown>,
): Estimate {
  const cap = (v: number): number => (customerCogs != null ? Math.min(v, customerCogs) : v);
  value = cap(value);
  return {
    method,
    valueCr: round2(value),
    valueLowCr: round2(cap(low)),
    valueHighCr: round2(cap(high)),
    supplierRevenuePct: supplierRevenue ? round2((value / supplierRevenue) * 100) : null,
    customerCostPct: customerCogs ? round2((value / customerCogs) * 100) : null,
    inputs,
  };
}

const round2 = (v: number): number => Math.round(v * 100) / 100;

export async function latestAnnualFinancials(
  db: Db,
  companyId: number,
): Promise<Financials | null> {
  const row = await db.query.fundamentals.findFirst({
    where: and(eq(fundamentals.companyId, companyId), eq(fundamentals.periodType, "annual")),
    orderBy: desc(fundamentals.periodEnd),
  });
  if (!row) return null;
  return {
    periodEnd: row.periodEnd,
    revenue: row.revenue == null ? null : Number(row.revenue),
    cogs: row.cogs == null ? null : Number(row.cogs),
  };
}

export async function refreshEstimates(db: Db, asOf = isoDate(new Date())): Promise<number> {
  const active = await db
    .select()
    .from(relationships)
    .where(and(lte(relationships.validFrom, asOf), gte(relationships.validTo, asOf)));
  const financials = new Map<number, Financials | null>();
  const getFin = async (id: number | null): Promise<Financials | null> => {
    if (id == null) return null;
    if (!financials.has(id)) financials.set(id, await latestAnnualFinancials(db, id));
    return financials.get(id) ?? null;
  };

  let written = 0;
  for (const rel of active) {
    const [supplier, customer] = await Promise.all([
      getFin(rel.supplierCompanyId),
      getFin(rel.customerCompanyId),
    ]);
    const top1 = rel.supplierCompanyId
      ? await db.query.signals.findFirst({
          where: and(
            eq(signals.companyId, rel.supplierCompanyId),
            eq(signals.kind, "top1_customers_pct"),
          ),
          orderBy: [desc(signals.asOf), desc(signals.modelVersion)],
        })
      : undefined;
    const est = estimateRelationship(rel, supplier, customer, {
      largestCustomerPct: top1?.value ?? null,
    });
    throwIfAborted();
    await db
      .insert(relationshipEstimates)
      .values({
        relationshipId: rel.id,
        asOf,
        method: est.method,
        valueCr: est.valueCr?.toString() ?? null,
        valueLowCr: est.valueLowCr?.toString() ?? null,
        valueHighCr: est.valueHighCr?.toString() ?? null,
        supplierRevenuePct: est.supplierRevenuePct,
        customerCostPct: est.customerCostPct,
        inputs: est.inputs,
        modelVersion: ESTIMATE_MODEL_VERSION,
      })
      .onConflictDoUpdate({
        target: [
          relationshipEstimates.relationshipId,
          relationshipEstimates.asOf,
          relationshipEstimates.modelVersion,
        ],
        set: {
          method: est.method,
          valueCr: est.valueCr?.toString() ?? null,
          valueLowCr: est.valueLowCr?.toString() ?? null,
          valueHighCr: est.valueHighCr?.toString() ?? null,
          supplierRevenuePct: est.supplierRevenuePct,
          customerCostPct: est.customerCostPct,
          inputs: est.inputs,
        },
      });
    written++;
  }
  return written;
}
