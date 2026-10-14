import { type Db, eq, fencedTransaction, relationshipPriors, sql } from "@ma/db";
import type { CostBucket } from "@ma/ingest";

export const PRIOR_MODEL_VERSION = 1;
export const MIN_PRIOR_DISCLOSURES = 20;
export const MIN_PRIOR_SUPPLIERS = 5;
export const ALL_CUES = "all";
const SHARE_CUES = ["revenue_share", "purchase_share"];

export interface PriorSample {
  sector: string;
  costBucket: CostBucket;
  cueClasses: readonly string[];
  supplierId: number;
  pct: number;
}

export interface Prior {
  supplierSector: string;
  costBucket: CostBucket;
  cueClass: string;
  disclosures: number;
  suppliers: number;
  shareP25: number;
  shareP50: number;
  shareP75: number;
}

export function priorKey(sector: string, bucket: CostBucket, cueClass: string): string {
  return `${sector}|${bucket}|${cueClass}`;
}

export function quantile(sorted: readonly number[], q: number): number {
  if (!sorted.length) return Number.NaN;
  const at = (sorted.length - 1) * q;
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  const a = sorted[lo] as number;
  const b = sorted[hi] as number;
  return a + (b - a) * (at - lo);
}

const round2 = (v: number): number => Math.round(v * 100) / 100;

export function buildPriors(samples: readonly PriorSample[]): Prior[] {
  const groups = new Map<string, { sample: PriorSample; cueClass: string; rows: PriorSample[] }>();
  for (const s of samples) {
    for (const cueClass of new Set([...s.cueClasses, ALL_CUES])) {
      const key = priorKey(s.sector, s.costBucket, cueClass);
      const group = groups.get(key) ?? { sample: s, cueClass, rows: [] };
      group.rows.push(s);
      groups.set(key, group);
    }
  }
  const priors: Prior[] = [];
  for (const { sample, cueClass, rows } of groups.values()) {
    const suppliers = new Set(rows.map((r) => r.supplierId)).size;
    if (rows.length < MIN_PRIOR_DISCLOSURES || suppliers < MIN_PRIOR_SUPPLIERS) continue;
    const sorted = rows.map((r) => r.pct).sort((a, b) => a - b);
    priors.push({
      supplierSector: sample.sector,
      costBucket: sample.costBucket,
      cueClass,
      disclosures: rows.length,
      suppliers,
      shareP25: round2(quantile(sorted, 0.25)),
      shareP50: round2(quantile(sorted, 0.5)),
      shareP75: round2(quantile(sorted, 0.75)),
    });
  }
  return priors.sort((a, b) =>
    priorKey(a.supplierSector, a.costBucket, a.cueClass).localeCompare(
      priorKey(b.supplierSector, b.costBucket, b.cueClass),
    ),
  );
}

export function priorFor(
  priors: ReadonlyMap<string, Prior>,
  sector: string | null,
  bucket: CostBucket,
  cueClass: string,
): Prior | null {
  if (!sector) return null;
  return (
    priors.get(priorKey(sector, bucket, cueClass)) ??
    priors.get(priorKey(sector, bucket, ALL_CUES)) ??
    null
  );
}

export async function loadPriorSamples(db: Db): Promise<PriorSample[]> {
  const shares = sql.join(
    SHARE_CUES.map((c) => sql`${c}`),
    sql`, `,
  );
  const rows = await db.execute<{
    supplier_id: number;
    sector: string;
    cost_bucket: CostBucket;
    pct: number;
    cues: string[] | null;
  }>(sql`
    select r.supplier_company_id as supplier_id, c.sector, r.cost_bucket, r.disclosed_pct as pct,
      array_agg(distinct o.cue_class) filter (where o.cue_class not in (${shares})) as cues
    from relationships r
    join companies c on c.id = r.supplier_company_id and c.sector is not null
    left join relationship_observations o
      on o.supplier_counterparty_id = r.supplier_counterparty_id
      and o.customer_counterparty_id = r.customer_counterparty_id
      and o.cost_bucket = r.cost_bucket and o.status in ('pending', 'auto', 'confirmed')
    where r.status in ('active', 'expired') and r.value_basis = 'revenue_share'
      and r.disclosed_pct > 0 and r.disclosed_pct <= 100
    group by r.id, c.sector`);
  return rows.map((r) => ({
    sector: r.sector,
    costBucket: r.cost_bucket,
    cueClasses: r.cues ?? [],
    supplierId: Number(r.supplier_id),
    pct: Number(r.pct),
  }));
}

export async function refreshPriors(
  db: Db,
  signal?: AbortSignal,
): Promise<{ samples: number; priors: number }> {
  const samples = await loadPriorSamples(db);
  const priors = buildPriors(samples);
  await fencedTransaction(
    db,
    async (tx) => {
      await tx
        .delete(relationshipPriors)
        .where(eq(relationshipPriors.modelVersion, PRIOR_MODEL_VERSION));
      if (priors.length) {
        await tx
          .insert(relationshipPriors)
          .values(priors.map((p) => ({ ...p, modelVersion: PRIOR_MODEL_VERSION })));
      }
    },
    signal,
  );
  return { samples: samples.length, priors: priors.length };
}

export async function loadPriors(db: Db): Promise<Map<string, Prior>> {
  const rows = await db
    .select()
    .from(relationshipPriors)
    .where(eq(relationshipPriors.modelVersion, PRIOR_MODEL_VERSION));
  return new Map(
    rows.map((r) => [
      priorKey(r.supplierSector, r.costBucket, r.cueClass),
      {
        supplierSector: r.supplierSector,
        costBucket: r.costBucket,
        cueClass: r.cueClass,
        disclosures: r.disclosures,
        suppliers: r.suppliers,
        shareP25: r.shareP25,
        shareP50: r.shareP50,
        shareP75: r.shareP75,
      },
    ]),
  );
}
