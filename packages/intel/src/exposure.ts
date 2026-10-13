import { and, type Db, desc, eq, fundamentals, inArray, lte, signals } from "@ma/db";
import { loadActiveLinks } from "./momentum.js";
import {
  type CoverageReason,
  loadCloses,
  RETURN_BASIS,
  seriesReturn,
  shiftDays,
} from "./prices.js";
import { dupont } from "./risk.js";
import { type OlsResult, ols } from "./stats.js";

export interface ExposureObservation {
  companyId: number;
  name: string;
  exposurePct: number;
  returnPct: number;
  leverage: number;
  assetTurnover: number;
  operatingMargin: number;
  interestBurden: number;
  taxBurden: number;
  distress: number;
}

export type MissingObservationReason =
  | CoverageReason
  | "no_fundamentals"
  | "incomplete_fundamentals";

export interface MissingObservation {
  companyId: number;
  name: string;
  reason: MissingObservationReason;
}

export interface EventImpactResult {
  shockCompanyId: number;
  window: { from: string; to: string };
  priceBasis: typeof RETURN_BASIS;
  observations: ExposureObservation[];
  missing: MissingObservation[];
  baseline: OlsResult | null;
  withExposure: OlsResult | null;
  exposureCoefficient: number | null;
  minObservations: number;
}

const FEATURES: Array<keyof ExposureObservation> = [
  "leverage",
  "assetTurnover",
  "operatingMargin",
  "interestBurden",
  "taxBurden",
  "distress",
];

export async function eventImpact(
  db: Db,
  shockCompanyId: number,
  from: string,
  to: string,
  opts: { minExposurePct?: number; minObservations?: number } = {},
): Promise<EventImpactResult> {
  const minExposure = opts.minExposurePct ?? 0;
  const minObservations = opts.minObservations ?? FEATURES.length + 3;
  const { byCustomer } = await loadActiveLinks(db, to);
  const suppliers = byCustomer.get(shockCompanyId) ?? [];
  const ids = suppliers.map((s) => s.counterpartyId);
  if (!ids.length) return empty(shockCompanyId, from, to, minObservations);

  const [closes, fins, distress] = await Promise.all([
    loadCloses(db, ids, shiftDays(from, -7), to),
    db
      .selectDistinctOn([fundamentals.companyId])
      .from(fundamentals)
      .where(
        and(
          inArray(fundamentals.companyId, ids),
          eq(fundamentals.periodType, "annual"),
          lte(fundamentals.periodEnd, to),
        ),
      )
      .orderBy(fundamentals.companyId, desc(fundamentals.periodEnd)),
    db
      .selectDistinctOn([signals.companyId])
      .from(signals)
      .where(
        and(
          inArray(signals.companyId, ids),
          eq(signals.kind, "distress_score"),
          lte(signals.asOf, to),
        ),
      )
      .orderBy(signals.companyId, desc(signals.asOf), desc(signals.modelVersion)),
  ]);
  const finById = new Map(fins.map((f) => [f.companyId, f]));
  const distressById = new Map(distress.map((d) => [d.companyId, d.value]));

  const observations: ExposureObservation[] = [];
  const missing: MissingObservation[] = [];
  const skip = (s: (typeof suppliers)[number], reason: MissingObservationReason) =>
    missing.push({ companyId: s.counterpartyId, name: s.counterpartyName, reason });
  for (const s of suppliers) {
    const priced = seriesReturn(closes, s.counterpartyId, from, to);
    if (!priced.ok) {
      skip(s, priced.reason);
      continue;
    }
    const f = finById.get(s.counterpartyId);
    const revenue = f?.revenue == null ? null : Number(f.revenue);
    if (!f || !revenue) {
      skip(s, "no_fundamentals");
      continue;
    }
    const ret = priced.value;
    const exposurePct = (s.weight / revenue) * 100;
    if (exposurePct < minExposure) continue;
    const r = dupont({
      revenue,
      operatingProfit: n(f.operatingProfit),
      interestExpense: n(f.interestExpense),
      pretaxIncome: n(f.pretaxIncome),
      netIncome: n(f.netIncome),
      totalAssets: n(f.totalAssets),
      totalEquity: n(f.totalEquity),
      totalDebt: n(f.totalDebt),
    });
    if (
      [r.leverage, r.assetTurnover, r.operatingMargin, r.interestBurden, r.taxBurden].some(
        (v) => v == null,
      )
    ) {
      skip(s, "incomplete_fundamentals");
      continue;
    }
    observations.push({
      companyId: s.counterpartyId,
      name: s.counterpartyName,
      exposurePct,
      returnPct: ret * 100,
      leverage: r.leverage as number,
      assetTurnover: r.assetTurnover as number,
      operatingMargin: r.operatingMargin as number,
      interestBurden: r.interestBurden as number,
      taxBurden: r.taxBurden as number,
      distress: distressById.get(s.counterpartyId) ?? 0.5,
    });
  }

  if (observations.length < minObservations)
    return { ...empty(shockCompanyId, from, to, minObservations), observations, missing };
  const y = observations.map((o) => o.returnPct);
  const baseX = observations.map((o) => FEATURES.map((f) => o[f] as number));
  const baseline = safeOls(baseX, y);
  const withExposure = safeOls(
    observations.map((o, i) => [...(baseX[i] as number[]), o.exposurePct]),
    y,
  );
  return {
    shockCompanyId,
    window: { from, to },
    priceBasis: RETURN_BASIS,
    observations,
    missing,
    baseline,
    withExposure,
    exposureCoefficient: withExposure?.coefficients.at(-1) ?? null,
    minObservations,
  };
}

function safeOls(X: number[][], y: number[]): OlsResult | null {
  try {
    return ols(X, y);
  } catch {
    return null;
  }
}

const n = (v: string | null): number | null => (v == null ? null : Number(v));

function empty(
  shockCompanyId: number,
  from: string,
  to: string,
  minObservations: number,
): EventImpactResult {
  return {
    shockCompanyId,
    window: { from, to },
    priceBasis: RETURN_BASIS,
    observations: [],
    missing: [],
    baseline: null,
    withExposure: null,
    exposureCoefficient: null,
    minObservations,
  };
}
