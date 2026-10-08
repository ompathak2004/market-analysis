import { and, companies, type Db, desc, eq, fundamentals, inArray, signals, sql } from "@ma/db";
import { logistic, zScores } from "./stats.js";

export const RISK_MODEL_VERSION = 1;

export interface DupontRatios {
  leverage: number | null;
  assetTurnover: number | null;
  operatingMargin: number | null;
  interestBurden: number | null;
  taxBurden: number | null;
  roe: number | null;
  interestCoverage: number | null;
  debtToEquity: number | null;
}

export function dupont(f: {
  revenue: number | null;
  operatingProfit: number | null;
  interestExpense: number | null;
  pretaxIncome: number | null;
  netIncome: number | null;
  totalAssets: number | null;
  totalEquity: number | null;
  totalDebt: number | null;
}): DupontRatios {
  const ebit =
    f.pretaxIncome != null && f.interestExpense != null
      ? f.pretaxIncome + f.interestExpense
      : f.operatingProfit;
  return {
    leverage: ratio(f.totalAssets, f.totalEquity),
    assetTurnover: ratio(f.revenue, f.totalAssets),
    operatingMargin: ratio(f.operatingProfit, f.revenue),
    interestBurden: ratio(f.pretaxIncome, ebit),
    taxBurden: ratio(f.netIncome, f.pretaxIncome),
    roe: ratio(f.netIncome, f.totalEquity),
    interestCoverage: f.interestExpense ? ratio(ebit, f.interestExpense) : null,
    debtToEquity: ratio(f.totalDebt, f.totalEquity),
  };
}

const WEIGHTS = {
  debtToEquity: 0.9,
  interestCoverage: -0.8,
  operatingMargin: -0.7,
  roe: -0.5,
  assetTurnover: -0.3,
} as const;

export function distressScores(ratios: DupontRatios[]): Array<number | null> {
  const cols = Object.keys(WEIGHTS) as Array<keyof typeof WEIGHTS>;
  const z = Object.fromEntries(
    cols.map((c) => [c, zScores(ratios.map((r) => clip(r[c])))]),
  ) as Record<keyof typeof WEIGHTS, Array<number | null>>;
  return ratios.map((_, i) => {
    let acc = 0;
    let used = 0;
    for (const c of cols) {
      const v = z[c][i];
      if (v == null) continue;
      acc += WEIGHTS[c] * v;
      used++;
    }
    return used < 3 ? null : logistic(acc - 1.5);
  });
}

const FINANCIALS_INDUSTRY = /bank|financ|insurance|nbfc|capital market|asset management/i;

export async function refreshRiskSignals(
  db: Db,
  companyIds: number[],
  asOf: string,
): Promise<number> {
  if (!companyIds.length) return 0;
  const industries = await db
    .select({ id: companies.id, industry: companies.industry, sector: companies.sector })
    .from(companies)
    .where(inArray(companies.id, companyIds));
  const nonFinancial = industries
    .filter((c) => !FINANCIALS_INDUSTRY.test(`${c.sector ?? ""} ${c.industry ?? ""}`))
    .map((c) => c.id);
  if (!nonFinancial.length) return 0;
  const latest = await db
    .selectDistinctOn([fundamentals.companyId])
    .from(fundamentals)
    .where(
      and(inArray(fundamentals.companyId, nonFinancial), eq(fundamentals.periodType, "annual")),
    )
    .orderBy(fundamentals.companyId, desc(fundamentals.periodEnd));
  const ratios = latest.map((f) =>
    dupont({
      revenue: num(f.revenue),
      operatingProfit: num(f.operatingProfit),
      interestExpense: num(f.interestExpense),
      pretaxIncome: num(f.pretaxIncome),
      netIncome: num(f.netIncome),
      totalAssets: num(f.totalAssets),
      totalEquity: num(f.totalEquity),
      totalDebt: num(f.totalDebt),
    }),
  );
  const scores = distressScores(ratios);
  let written = 0;
  for (const [i, f] of latest.entries()) {
    const score = scores[i];
    if (score == null) continue;
    await db
      .insert(signals)
      .values({
        companyId: f.companyId,
        asOf,
        kind: "distress_score",
        value: score,
        inputs: { ...ratios[i], periodEnd: f.periodEnd },
        modelVersion: RISK_MODEL_VERSION,
      })
      .onConflictDoUpdate({
        target: [signals.companyId, signals.asOf, signals.kind, signals.modelVersion],
        set: { value: sql`excluded.value`, inputs: sql`excluded.inputs` },
      });
    written++;
  }
  return written;
}

const num = (v: string | null): number | null => (v == null ? null : Number(v));

function ratio(a: number | null, b: number | null): number | null {
  if (a == null || b == null || b === 0) return null;
  return a / b;
}

function clip(v: number | null): number | null {
  if (v == null) return null;
  return Math.max(-50, Math.min(50, v));
}
