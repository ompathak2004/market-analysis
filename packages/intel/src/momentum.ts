import { throwIfAborted } from "@ma/core";
import {
  and,
  type Db,
  desc,
  eq,
  fencedBatches,
  gte,
  lte,
  ne,
  relationshipEstimates,
  relationships,
  signals,
  sql,
} from "@ma/db";
import { ESTIMATE_MODEL_VERSION } from "./estimates.js";
import {
  type CoverageReason,
  coverageCounts,
  loadCloses,
  RETURN_BASIS,
  seriesReturn,
  shiftDays,
} from "./prices.js";

export const MOMENTUM_MODEL_VERSION = 2;

export const HORIZONS = { "1m": 30, "2m": 61, "3m": 91 } as const;
export type Horizon = keyof typeof HORIZONS;

export interface WeightedLink {
  companyId: number;
  counterpartyId: number;
  counterpartyName: string;
  weight: number;
  valueCr: number | null;
  method: string;
}

export async function loadActiveLinks(
  db: Db,
  asOf: string,
): Promise<{ bySupplier: Map<number, WeightedLink[]>; byCustomer: Map<number, WeightedLink[]> }> {
  const rows = await db
    .select({
      supplierId: relationships.supplierCompanyId,
      supplierName: relationships.supplierName,
      customerId: relationships.customerCompanyId,
      customerName: relationships.customerName,
      valueCr: relationshipEstimates.valueCr,
      supplierRevenuePct: relationshipEstimates.supplierRevenuePct,
      method: relationshipEstimates.method,
    })
    .from(relationships)
    .innerJoin(
      relationshipEstimates,
      and(
        eq(relationshipEstimates.relationshipId, relationships.id),
        eq(relationshipEstimates.modelVersion, ESTIMATE_MODEL_VERSION),
        ne(relationshipEstimates.valueBasis, "contract_total"),
      ),
    )
    .where(
      and(
        eq(relationships.status, "active"),
        lte(relationships.validFrom, asOf),
        gte(relationships.validTo, asOf),
        lte(relationshipEstimates.asOf, asOf),
      ),
    )
    .orderBy(desc(relationshipEstimates.asOf));

  const bySupplier = new Map<number, WeightedLink[]>();
  const byCustomer = new Map<number, WeightedLink[]>();
  const seen = new Set<string>();
  for (const r of rows) {
    if (r.supplierId == null || r.customerId == null) continue;
    const key = `${r.supplierId}:${r.customerId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const valueCr = r.valueCr != null ? Number(r.valueCr) : null;
    const weight = valueCr ?? r.supplierRevenuePct ?? 1;
    push(bySupplier, r.supplierId, {
      companyId: r.supplierId,
      counterpartyId: r.customerId,
      counterpartyName: r.customerName,
      weight,
      valueCr,
      method: r.method,
    });
    push(byCustomer, r.customerId, {
      companyId: r.customerId,
      counterpartyId: r.supplierId,
      counterpartyName: r.supplierName,
      weight,
      valueCr,
      method: r.method,
    });
  }
  return { bySupplier, byCustomer };
}

export interface MomentumResult {
  companyId: number;
  horizon: Horizon;
  value: number;
  contributors: Array<{ counterpartyId: number; name: string; weight: number; momentum: number }>;
}

export function weightedMomentum(
  links: WeightedLink[],
  momentumOf: (counterpartyId: number) => number | null,
): Omit<MomentumResult, "companyId" | "horizon"> | null {
  const contributors = links.flatMap((l) => {
    const m = momentumOf(l.counterpartyId);
    return m == null || l.weight <= 0
      ? []
      : [
          {
            counterpartyId: l.counterpartyId,
            name: l.counterpartyName,
            weight: l.weight,
            momentum: m,
          },
        ];
  });
  const total = contributors.reduce((s, c) => s + c.weight, 0);
  if (!contributors.length || total === 0) return null;
  return {
    value: contributors.reduce((s, c) => s + (c.weight / total) * c.momentum, 0),
    contributors: contributors.map((c) => ({ ...c, weight: c.weight / total })),
  };
}

export async function refreshMomentumSignals(db: Db, asOf: string): Promise<number> {
  const { bySupplier, byCustomer } = await loadActiveLinks(db, asOf);
  const ids = new Set<number>();
  for (const links of [...bySupplier.values(), ...byCustomer.values()]) {
    for (const l of links) {
      ids.add(l.companyId);
      ids.add(l.counterpartyId);
    }
  }
  const from = shiftDays(asOf, -HORIZONS["3m"] - 10);
  const closes = await loadCloses(db, [...ids], from, asOf);

  const rows: Array<typeof signals.$inferInsert> = [];
  const write = (
    companyId: number,
    kind: string,
    value: number,
    inputs: Record<string, unknown>,
  ) => {
    rows.push({ companyId, asOf, kind, value, inputs, modelVersion: MOMENTUM_MODEL_VERSION });
  };

  for (const [prefix, map] of [
    ["customer_momentum", bySupplier],
    ["supplier_momentum", byCustomer],
  ] as const) {
    for (const [companyId, links] of map) {
      throwIfAborted();
      for (const [horizon, days] of Object.entries(HORIZONS) as Array<[Horizon, number]>) {
        const start = shiftDays(asOf, -days);
        const missing = new Map<number, CoverageReason>();
        const res = weightedMomentum(links, (id) => {
          const r = seriesReturn(closes, id, start, asOf);
          if (r.ok) return r.value;
          missing.set(id, r.reason);
          return null;
        });
        if (res)
          write(companyId, `${prefix}_${horizon}`, res.value * 100, {
            contributors: res.contributors.map((c) => ({
              ...c,
              generation: closes.meta.get(c.counterpartyId)?.generation ?? null,
            })),
            from: start,
            priceBasis: RETURN_BASIS,
            coverage: {
              counterparties: links.length,
              priced: res.contributors.length,
              missing: coverageCounts(missing.values()),
            },
          });
      }
    }
  }
  await fencedBatches(db, rows, (tx, batch) =>
    tx
      .insert(signals)
      .values(batch)
      .onConflictDoUpdate({
        target: [signals.companyId, signals.asOf, signals.kind, signals.modelVersion],
        set: { value: sql`excluded.value`, inputs: sql`excluded.inputs` },
      }),
  );
  return rows.length;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const arr = map.get(key);
  if (arr) arr.push(value);
  else map.set(key, [value]);
}
