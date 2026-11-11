import {
  type AssetClass,
  CESS_RATE,
  exemptionFor,
  GRANDFATHER_CUTOFF,
  longTermFrom,
  TAX_ASSUMPTIONS,
  TAX_RULES_VERSION,
  windowFor,
  yearOf,
} from "./rules.js";

export interface TaxLotInput {
  symbol: string;
  assetClass: AssetClass;
  acquired: string;
  disposed: string;
  quantity: number;
  costPerShare: number;
  salePerShare: number;
  fmv2018PerShare: number | null;
}

export interface ClassifiedLot extends TaxLotInput {
  term: "short" | "long";
  longTermFrom: string;
  daysHeld: number;
  window: string;
  section: string;
  rate: number;
  costBasis: number;
  gain: number;
  grandfathered: boolean;
  missing: string[];
}

export interface YearEstimate {
  year: string;
  stcg: number;
  stcl: number;
  ltcg: number;
  ltcl: number;
  exemption: number;
  exemptionUsed: number;
  taxableShortTerm: number;
  taxableLongTerm: number;
  tax: number;
  cess: number;
  total: number;
  buckets: Array<{
    term: "short" | "long";
    section: string;
    rate: number;
    taxable: number;
    tax: number;
  }>;
}

export interface GainsEstimate {
  rulesVersion: string;
  lots: ClassifiedLot[];
  years: YearEstimate[];
  exact: boolean;
  missing: string[];
  assumptions: readonly string[];
  disclaimer: string;
}

export class TaxRuleError extends Error {}

const DISCLAIMER =
  "Educational estimate from deterministic rules, not tax advice; actual liability depends on total income, regime and filing position.";

export function classifyLot(lot: TaxLotInput): ClassifiedLot {
  if (lot.disposed < lot.acquired)
    throw new TaxRuleError(`${lot.symbol}: disposal before acquisition`);
  const w = windowFor(lot.disposed);
  if (!w) throw new TaxRuleError(`${lot.symbol}: no rule window covers ${lot.disposed}`);
  const ltFrom = longTermFrom(lot.acquired);
  const term = lot.disposed >= ltFrom ? "long" : "short";
  const missing: string[] = [];
  let cost = lot.costPerShare;
  let grandfathered = false;
  if (term === "long" && lot.acquired < GRANDFATHER_CUTOFF) {
    if (lot.fmv2018PerShare == null) {
      missing.push(`${lot.symbol}: fair market value on 31 Jan 2018 (acquired ${lot.acquired})`);
    } else {
      cost = Math.max(lot.costPerShare, Math.min(lot.fmv2018PerShare, lot.salePerShare));
      grandfathered = cost !== lot.costPerShare;
    }
  }
  const costBasis = cost * lot.quantity;
  return {
    ...lot,
    term,
    longTermFrom: ltFrom,
    daysHeld: Math.round(
      (Date.parse(`${lot.disposed}T00:00:00Z`) - Date.parse(`${lot.acquired}T00:00:00Z`)) /
        86_400_000,
    ),
    window: w.id,
    section: term === "short" ? `${w.act} ${w.stcgSection}` : `${w.act} ${w.ltcgSection}`,
    rate: term === "short" ? w.stcgRate : w.ltcgRate,
    costBasis,
    gain: lot.salePerShare * lot.quantity - costBasis,
    grandfathered,
    missing,
  };
}

function absorb(
  buckets: Array<{ term: "short" | "long"; rate: number; taxable: number }>,
  term: "short" | "long",
  amount: number,
): number {
  let left = amount;
  for (const b of buckets.filter((x) => x.term === term).sort((a, b) => b.rate - a.rate)) {
    const used = Math.min(b.taxable, left);
    b.taxable -= used;
    left -= used;
  }
  return left;
}

function estimateYear(year: { label: string; start: string }, lots: ClassifiedLot[]): YearEstimate {
  const buckets = new Map<
    string,
    { term: "short" | "long"; section: string; rate: number; taxable: number }
  >();
  let stcl = 0;
  let ltcl = 0;
  for (const l of lots) {
    if (l.gain < 0) {
      if (l.term === "short") stcl -= l.gain;
      else ltcl -= l.gain;
      continue;
    }
    const key = `${l.term}:${l.section}:${l.rate}`;
    const b = buckets.get(key) ?? { term: l.term, section: l.section, rate: l.rate, taxable: 0 };
    b.taxable += l.gain;
    buckets.set(key, b);
  }
  const list = [...buckets.values()];
  const stcg = list.filter((b) => b.term === "short").reduce((s, b) => s + b.taxable, 0);
  const ltcg = list.filter((b) => b.term === "long").reduce((s, b) => s + b.taxable, 0);
  const stclLeft = absorb(list, "short", stcl);
  absorb(list, "long", stclLeft);
  absorb(list, "long", ltcl);
  const exemption = exemptionFor(year.start);
  const ltAfterSetoff = list.filter((b) => b.term === "long").reduce((s, b) => s + b.taxable, 0);
  const exemptionUsed = Math.min(exemption, ltAfterSetoff);
  absorb(list, "long", exemptionUsed);
  const out = list.map((b) => ({ ...b, tax: b.taxable * b.rate }));
  const tax = out.reduce((s, b) => s + b.tax, 0);
  const cess = tax * CESS_RATE;
  return {
    year: year.label,
    stcg,
    stcl,
    ltcg,
    ltcl,
    exemption,
    exemptionUsed,
    taxableShortTerm: out.filter((b) => b.term === "short").reduce((s, b) => s + b.taxable, 0),
    taxableLongTerm: out.filter((b) => b.term === "long").reduce((s, b) => s + b.taxable, 0),
    tax,
    cess,
    total: tax + cess,
    buckets: out,
  };
}

export function estimateGains(inputs: readonly TaxLotInput[]): GainsEstimate {
  const lots = inputs.map(classifyLot);
  const byYear = new Map<string, { year: ReturnType<typeof yearOf>; lots: ClassifiedLot[] }>();
  for (const l of lots) {
    const y = yearOf(l.disposed);
    const g = byYear.get(y.label) ?? { year: y, lots: [] };
    g.lots.push(l);
    byYear.set(y.label, g);
  }
  const missing = lots.flatMap((l) => l.missing);
  return {
    rulesVersion: TAX_RULES_VERSION,
    lots,
    years: [...byYear.values()]
      .sort((a, b) => a.year.start.localeCompare(b.year.start))
      .map((g) => estimateYear(g.year, g.lots)),
    exact: missing.length === 0,
    missing,
    assumptions: TAX_ASSUMPTIONS,
    disclaimer: DISCLAIMER,
  };
}
