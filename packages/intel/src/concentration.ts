import { throwIfAborted } from "@ma/core";
import { type Db, fencedBatches, signals, sql } from "@ma/db";
import { ESTIMATE_MODEL_VERSION } from "./estimates.js";
import { loadActiveLinks, type WeightedLink } from "./momentum.js";
import { hhi } from "./stats.js";

export const CONCENTRATION_MODEL_VERSION = 3;

export interface CustomerConcentration {
  hhi: number;
  customers: Array<{ id: number; name: string; share: number; method: string }>;
  unvalued: number;
}

export function customerConcentration(
  links: readonly WeightedLink[],
): CustomerConcentration | null {
  const valued = links.filter((l) => l.valueCr !== null && l.valueCr > 0);
  const total = valued.reduce((s, l) => s + (l.valueCr as number), 0);
  if (!valued.length || total <= 0) return null;
  const customers = valued.map((l) => ({
    id: l.counterpartyId,
    name: l.counterpartyName,
    share: (l.valueCr as number) / total,
    method: l.method,
  }));
  return {
    hhi: hhi(customers.map((c) => c.share)),
    customers,
    unvalued: links.length - valued.length,
  };
}

export async function refreshConcentrationSignals(
  db: Db,
  asOf: string,
  signal?: AbortSignal,
): Promise<number> {
  const { bySupplier } = await loadActiveLinks(db, asOf);
  const rows: Array<typeof signals.$inferInsert> = [];
  for (const [companyId, links] of bySupplier) {
    throwIfAborted(signal);
    const c = customerConcentration(links);
    if (!c) continue;
    rows.push({
      companyId,
      asOf,
      kind: "customer_hhi",
      value: c.hhi,
      inputs: {
        customers: c.customers,
        unvalued: c.unvalued,
        estimateModelVersion: ESTIMATE_MODEL_VERSION,
      },
      modelVersion: CONCENTRATION_MODEL_VERSION,
    });
  }
  await fencedBatches(
    db,
    rows,
    (tx, batch) =>
      tx
        .insert(signals)
        .values(batch)
        .onConflictDoUpdate({
          target: [signals.companyId, signals.asOf, signals.kind, signals.modelVersion],
          set: { value: sql`excluded.value`, inputs: sql`excluded.inputs` },
        }),
    { signal: signal ?? null },
  );
  return rows.length;
}
