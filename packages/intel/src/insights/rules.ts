import type { AltdataSignal } from "../altdata/types.js";
import type { AnnualRow, CompanyInputs } from "./inputs.js";
import type { RuleGroup, RuleInsight } from "./schemas.js";

export const RULE_THRESHOLDS = {
  farBelowHighPct: 20,
  nearHighPct: 5,
  nearLowPct: 5,
  relStrengthPp: 3,
  growthGapPp: 5,
  marginGapPp: 3,
  cagrStrongPct: 15,
  cagrWeakPct: 0,
  marginSlopePpPerQuarter: 0.5,
  highDebtToEquity: 1.5,
  lowDebtToEquity: 0.3,
  weakInterestCover: 2.5,
  strongInterestCover: 8,
  cashConversionGood: 0.9,
  cashConversionPoor: 0.6,
  qualityGood: 5,
  qualityPoor: 2,
  qualityMinCriteria: 4,
  promoterChangePp: 0.5,
  institutionalChangePp: 1,
  pledgeHighPct: 20,
  upsideHighPct: 15,
  skewBullishPp: 50,
  skewBearishPp: 0,
  revisionPct: 2,
  surpriseStreak: 2,
  concentrationPct: 25,
  momentumPct: 5,
  distressHigh: 0.6,
  distressLow: 0.3,
} as const;

const FINANCIALS = /bank|financ|insurance|nbfc|capital market|asset management/i;

type Tone = RuleInsight["tone"];

const insight = (
  id: string,
  group: RuleGroup,
  tone: Tone,
  text: string,
  value: number | null,
  evidence: string[],
): RuleInsight => ({ id, group, tone, text, value, evidence });

const n1 = (v: number) => v.toFixed(1);
const n2 = (v: number) => v.toFixed(2);
const pct = (v: number) => `${n1(v)}%`;
const signedPp = (v: number) => `${v >= 0 ? "+" : ""}${n1(v)} pp`;
const rupees = (v: number) => `₹${v.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const T = RULE_THRESHOLDS;

function dist52w(i: CompanyInputs): RuleInsight | null {
  const p = i.price;
  if (!p || p.distToHighPct == null || p.high52w == null) return null;
  const below = -p.distToHighPct;
  const lowText =
    p.distToLowPct != null && p.low52w != null
      ? `, ${pct(p.distToLowPct)} above the 52-week low of ${rupees(p.low52w)}`
      : "";
  if (below >= T.farBelowHighPct) {
    return insight(
      "price.dist_52w",
      "price",
      "negative",
      `Trading ${pct(below)} below the 52-week high of ${rupees(p.high52w)}${lowText}.`,
      p.distToHighPct,
      ["px"],
    );
  }
  if (below <= T.nearHighPct) {
    return insight(
      "price.dist_52w",
      "price",
      "positive",
      `Within ${pct(below)} of the 52-week high of ${rupees(p.high52w)}.`,
      p.distToHighPct,
      ["px"],
    );
  }
  if (p.distToLowPct != null && p.low52w != null && p.distToLowPct <= T.nearLowPct) {
    return insight(
      "price.dist_52w",
      "price",
      "negative",
      `Within ${pct(p.distToLowPct)} of the 52-week low of ${rupees(p.low52w)}.`,
      p.distToHighPct,
      ["px"],
    );
  }
  return insight(
    "price.dist_52w",
    "price",
    "neutral",
    `${pct(below)} below the 52-week high of ${rupees(p.high52w)}${lowText}.`,
    p.distToHighPct,
    ["px"],
  );
}

function maRegime(i: CompanyInputs): RuleInsight | null {
  const p = i.price;
  if (!p || p.dma50 == null || p.dma200 == null) return null;
  const above50 = p.last > p.dma50;
  const above200 = p.last > p.dma200;
  const tone: Tone =
    above50 && above200 ? "positive" : !above50 && !above200 ? "negative" : "neutral";
  const where = (above: boolean, label: string, v: number) =>
    `${above ? "above" : "below"} the ${label} (${rupees(v)})`;
  const cross = p.cross
    ? ` A ${p.cross.kind === "golden" ? "golden" : "death"} cross formed ${p.cross.sessionsAgo === 0 ? "in the latest session" : `${p.cross.sessionsAgo} sessions ago`}.`
    : "";
  const finalTone: Tone = p.cross ? (p.cross.kind === "golden" ? "positive" : "negative") : tone;
  return insight(
    "price.ma_regime",
    "price",
    finalTone,
    `Price ${rupees(p.last)} is ${where(above50, "50-DMA", p.dma50)} and ${where(above200, "200-DMA", p.dma200)}.${cross}`,
    p.dma200 ? Math.round((p.last / p.dma200 - 1) * 1000) / 10 : null,
    ["px"],
  );
}

function relNifty(i: CompanyInputs): RuleInsight | null {
  const p = i.price;
  const rel = p?.relVsNifty3mPct ?? p?.relVsNifty1mPct ?? null;
  if (!p || rel == null) return null;
  const horizon = p.relVsNifty3mPct != null ? "3 months" : "1 month";
  const tone: Tone =
    rel >= T.relStrengthPp ? "positive" : rel <= -T.relStrengthPp ? "negative" : "neutral";
  const verb =
    tone === "positive" ? "Outperformed" : tone === "negative" ? "Underperformed" : "In line with";
  return insight(
    "price.rel_nifty",
    "price",
    tone,
    `${verb} the NIFTY 50 over ${horizon} (${signedPp(rel)}).`,
    rel,
    ["px"],
  );
}

function growthVsSector(i: CompanyInputs): RuleInsight | null {
  const f = i.fundamentals;
  const m = f?.sectorMedians;
  if (!f || !m || f.growth.revenueYoyPct == null || m.revenueYoyPct == null) return null;
  const gap = Math.round((f.growth.revenueYoyPct - m.revenueYoyPct) * 10) / 10;
  const tone: Tone =
    gap >= T.growthGapPp ? "positive" : gap <= -T.growthGapPp ? "negative" : "neutral";
  const pat =
    f.growth.patYoyPct != null && m.patYoyPct != null
      ? `; PAT ${pct(f.growth.patYoyPct)} vs ${pct(m.patYoyPct)}`
      : "";
  return insight(
    "financials.growth_vs_sector",
    "industry",
    tone,
    `Revenue grew ${pct(f.growth.revenueYoyPct)} YoY vs the ${m.sector} median of ${pct(m.revenueYoyPct)} (${signedPp(gap)})${pat}.`,
    gap,
    ["fin"],
  );
}

function marginVsSector(i: CompanyInputs): RuleInsight | null {
  const f = i.fundamentals;
  const m = f?.sectorMedians;
  if (
    !f ||
    !m ||
    f.ratios.opmPct == null ||
    m.opmPct == null ||
    FINANCIALS.test(i.company.industry ?? "")
  )
    return null;
  const gap = Math.round((f.ratios.opmPct - m.opmPct) * 10) / 10;
  const tone: Tone =
    gap >= T.marginGapPp ? "positive" : gap <= -T.marginGapPp ? "negative" : "neutral";
  return insight(
    "industry.margin_vs_sector",
    "industry",
    tone,
    `Operating margin ${pct(f.ratios.opmPct)} vs the ${m.sector} median of ${pct(m.opmPct)} (${signedPp(gap)}).`,
    gap,
    ["fin"],
  );
}

function cagr3y(i: CompanyInputs): RuleInsight | null {
  const g = i.fundamentals?.growth;
  if (!g || g.revenueCagr3yPct == null) return null;
  const v = g.revenueCagr3yPct;
  const tone: Tone = v >= T.cagrStrongPct ? "positive" : v < T.cagrWeakPct ? "negative" : "neutral";
  const pat = g.patCagr3yPct != null ? `, PAT ${pct(g.patCagr3yPct)}` : "";
  return insight(
    "financials.cagr3y",
    "financials",
    tone,
    `3-year CAGR: revenue ${pct(v)}${pat}.`,
    v,
    ["fin"],
  );
}

export function slope(values: number[]): number | null {
  if (values.length < 2) return null;
  const n = values.length;
  const mx = (n - 1) / 2;
  const my = values.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let den = 0;
  values.forEach((v, x) => {
    num += (x - mx) * (v - my);
    den += (x - mx) ** 2;
  });
  return den ? num / den : null;
}

function marginTrend(i: CompanyInputs): RuleInsight | null {
  const q = i.fundamentals?.quarterly ?? [];
  const series = q
    .slice(0, 4)
    .map((r) => r.opmPct)
    .reverse();
  if (
    series.length < 4 ||
    series.some((v) => v == null) ||
    FINANCIALS.test(i.company.industry ?? "")
  )
    return null;
  const values = series as number[];
  const s = slope(values);
  if (s == null) return null;
  const tone: Tone =
    s >= T.marginSlopePpPerQuarter
      ? "positive"
      : s <= -T.marginSlopePpPerQuarter
        ? "negative"
        : "neutral";
  const word = tone === "positive" ? "expanding" : tone === "negative" ? "contracting" : "stable";
  return insight(
    "financials.margin_trend",
    "financials",
    tone,
    `Quarterly operating margin ${word}: ${values.map(pct).join(" → ")} over the last 4 quarters.`,
    Math.round(s * 100) / 100,
    ["fin"],
  );
}

function leverage(i: CompanyInputs): RuleInsight | null {
  const r = i.fundamentals?.ratios;
  if (
    !r ||
    FINANCIALS.test(i.company.industry ?? "") ||
    (r.debtToEquity == null && r.interestCover == null)
  )
    return null;
  const de = r.debtToEquity;
  const ic = r.interestCover;
  const weak = (de != null && de >= T.highDebtToEquity) || (ic != null && ic < T.weakInterestCover);
  const strong =
    de != null && de <= T.lowDebtToEquity && (ic == null || ic >= T.strongInterestCover);
  const parts = [
    de != null ? `debt/equity ${n2(de)}` : null,
    ic != null ? `interest cover ${n1(ic)}x` : null,
  ].filter(Boolean);
  return insight(
    "financials.leverage",
    "financials",
    weak ? "negative" : strong ? "positive" : "neutral",
    `Balance sheet: ${parts.join(", ")}.`,
    de,
    ["fin"],
  );
}

function cashConversion(i: CompanyInputs): RuleInsight | null {
  const c = i.fundamentals?.ratios.cashConversion3y;
  if (c == null || FINANCIALS.test(i.company.industry ?? "")) return null;
  const tone: Tone =
    c >= T.cashConversionGood ? "positive" : c < T.cashConversionPoor ? "negative" : "neutral";
  return insight(
    "financials.cash_conversion",
    "financials",
    tone,
    `Operating cash flow was ${n2(c)}x reported PAT over 3 years.`,
    c,
    ["fin"],
  );
}

const safeDiv = (a: number | null, b: number | null) =>
  a == null || b == null || b === 0 ? null : a / b;

export function qualityCriteria(
  a0: AnnualRow,
  a1: AnnualRow | undefined,
): { score: number; of: number } {
  const checks: Array<boolean | null> = [
    a0.netIncome == null ? null : a0.netIncome > 0,
    a0.cashFromOps == null ? null : a0.cashFromOps > 0,
    a0.cashFromOps == null || a0.netIncome == null ? null : a0.cashFromOps > a0.netIncome,
  ];
  if (a1) {
    const cmp = (now: number | null, then: number | null, up: boolean) =>
      now == null || then == null ? null : up ? now > then : now < then;
    checks.push(
      cmp(safeDiv(a0.netIncome, a0.totalAssets), safeDiv(a1.netIncome, a1.totalAssets), true),
      cmp(safeDiv(a0.totalDebt, a0.totalEquity), safeDiv(a1.totalDebt, a1.totalEquity), false),
      cmp(
        safeDiv(a0.currentAssets, a0.currentLiabilities),
        safeDiv(a1.currentAssets, a1.currentLiabilities),
        true,
      ),
      cmp(safeDiv(a0.operatingProfit, a0.revenue), safeDiv(a1.operatingProfit, a1.revenue), true),
    );
  }
  const known = checks.filter((c): c is boolean => c != null);
  return { score: known.filter(Boolean).length, of: known.length };
}

function qualityScore(i: CompanyInputs): RuleInsight | null {
  const [a0, a1] = i.fundamentals?.annual ?? [];
  if (!a0 || FINANCIALS.test(i.company.industry ?? "")) return null;
  const q = qualityCriteria(a0, a1);
  if (q.of < T.qualityMinCriteria) return null;
  const ratio = q.score / q.of;
  const tone: Tone =
    q.score >= T.qualityGood
      ? "positive"
      : q.score <= T.qualityPoor
        ? "negative"
        : ratio >= 0.7
          ? "positive"
          : "neutral";
  return insight(
    "financials.quality_score",
    "financials",
    tone,
    `Our quality score is ${q.score} of ${q.of} (profitability, cash flow, accruals, leverage, liquidity and margin checks).`,
    q.score,
    ["fin"],
  );
}

function holdingChange(i: CompanyInputs, holder: "promoter" | "fii" | "dii"): RuleInsight | null {
  const s = i.shareholding;
  const d = s?.qoq[holder];
  const level = s
    ? holder === "promoter"
      ? s.promoterPct
      : holder === "fii"
        ? s.fiiPct
        : s.diiPct
    : null;
  if (!s || d == null || level == null) return null;
  const label = holder === "promoter" ? "Promoter" : holder.toUpperCase();
  const threshold = holder === "promoter" ? T.promoterChangePp : T.institutionalChangePp;
  if (Math.abs(d) < threshold) {
    if (holder !== "promoter") return null;
    return insight(
      `shareholding.${holder}_qoq`,
      "shareholding",
      "neutral",
      `${label} holding steady at ${n2(level)}% in the ${s.latestQuarter} quarter.`,
      d,
      ["shp"],
    );
  }
  return insight(
    `shareholding.${holder}_qoq`,
    "shareholding",
    d > 0 ? "positive" : "negative",
    `${label} holding ${d > 0 ? "rose" : "fell"} ${n2(Math.abs(d))} pp to ${n2(level)}% in the ${s.latestQuarter} quarter.`,
    d,
    ["shp"],
  );
}

function pledge(i: CompanyInputs): RuleInsight | null {
  const p = i.shareholding?.pledgePct;
  if (p == null) return null;
  if (p === 0)
    return insight(
      "shareholding.pledge",
      "shareholding",
      "positive",
      "No promoter shares pledged.",
      0,
      ["shp"],
    );
  const high = p > T.pledgeHighPct;
  return insight(
    "shareholding.pledge",
    "shareholding",
    "negative",
    `${high ? "High promoter pledge" : "Promoter pledge"} of ${n2(p)}% of promoter holding.`,
    p,
    ["shp"],
  );
}

function upside(i: CompanyInputs): RuleInsight | null {
  const c = i.consensus;
  if (!c || c.upsideToMeanPct == null || c.targetMean == null) return null;
  const u = c.upsideToMeanPct;
  const tone: Tone = u >= T.upsideHighPct ? "positive" : u <= 0 ? "negative" : "neutral";
  const range =
    c.targetLow != null && c.targetHigh != null
      ? ` (range ${rupees(c.targetLow)}–${rupees(c.targetHigh)})`
      : "";
  return insight(
    "consensus.upside_to_mean",
    "consensus",
    tone,
    `Mean target ${rupees(c.targetMean)}${range} implies ${pct(u)} ${u >= 0 ? "upside" : "downside"}.`,
    u,
    ["cns"],
  );
}

function skew(i: CompanyInputs): RuleInsight | null {
  const c = i.consensus;
  if (!c || c.buyPct == null || c.sellPct == null) return null;
  const s = Math.round((c.buyPct - c.sellPct) * 10) / 10;
  const tone: Tone =
    s >= T.skewBullishPp ? "positive" : s <= T.skewBearishPp ? "negative" : "neutral";
  const count = c.analystCount != null ? ` across ${c.analystCount} analysts` : "";
  return insight(
    "consensus.skew",
    "consensus",
    tone,
    `${pct(c.buyPct)} buy vs ${pct(c.sellPct)} sell ratings${count}.`,
    s,
    ["cns"],
  );
}

function revision(i: CompanyInputs): RuleInsight | null {
  const r = i.consensus?.epsNextFyRevision30dPct;
  if (r == null) return null;
  const tone: Tone = r >= T.revisionPct ? "positive" : r <= -T.revisionPct ? "negative" : "neutral";
  return insight(
    "consensus.revision",
    "consensus",
    tone,
    `Next-FY EPS estimate revised ${signedPp(r).replace(" pp", "%")} over 30 days.`,
    r,
    ["cns"],
  );
}

function surpriseStreak(i: CompanyInputs): RuleInsight | null {
  const s = i.consensus?.surprises ?? [];
  const first = s[0]?.outcome;
  if (!first) return null;
  let streak = 0;
  for (const x of s) {
    if (x.outcome !== first) break;
    streak++;
  }
  const beat = /beat|positive/i.test(first);
  const miss = /miss|negative/i.test(first);
  if (streak < T.surpriseStreak || (!beat && !miss)) return null;
  return insight(
    "consensus.surprise_streak",
    "consensus",
    beat ? "positive" : "negative",
    `${streak} consecutive quarterly ${(s[0]?.metric ?? "").replace(/_/g, " ")} ${beat ? "beats" : "misses"}.`.replace(
      "  ",
      " ",
    ),
    streak,
    ["cns"],
  );
}

function scEvidence(i: CompanyInputs): string[] {
  const sc = i.supplyChain;
  return ["sig:supply_chain", ...(sc?.customers.slice(0, 2).map((c) => c.evidenceId) ?? [])];
}

function concentration(i: CompanyInputs): RuleInsight | null {
  const v = i.supplyChain?.signals.customerConcentrationPct;
  if (v == null) return null;
  return insight(
    "supply_chain.concentration",
    "supply_chain",
    v >= T.concentrationPct ? "negative" : "neutral",
    `Disclosed large customers account for ${pct(v)} of revenue.`,
    v,
    scEvidence(i),
  );
}

function scMomentum(i: CompanyInputs): RuleInsight | null {
  const v = i.supplyChain?.signals.customerMomentum3mPct;
  if (v == null) return null;
  const tone: Tone = v >= T.momentumPct ? "positive" : v <= -T.momentumPct ? "negative" : "neutral";
  return insight(
    "supply_chain.momentum",
    "supply_chain",
    tone,
    `Revenue-weighted customer share prices moved ${pct(v)} over 3 months.`,
    v,
    scEvidence(i),
  );
}

function distress(i: CompanyInputs): RuleInsight | null {
  const v = i.supplyChain?.signals.distressScore;
  if (v == null) return null;
  const tone: Tone = v >= T.distressHigh ? "negative" : v <= T.distressLow ? "positive" : "neutral";
  const band = tone === "negative" ? "elevated" : tone === "positive" ? "low" : "moderate";
  return insight(
    "supply_chain.distress",
    "supply_chain",
    tone,
    `Distress score ${n2(v)} (${band}).`,
    v,
    ["sig:supply_chain"],
  );
}

function altData(i: CompanyInputs): RuleInsight[] {
  const all: AltdataSignal[] = [...(i.travel ?? []), ...(i.logistics ?? [])];
  return all
    .filter((s) => !s.kind.endsWith("_coverage") && s.inputs.read.trim().length > 0)
    .map((s) =>
      insight(
        `alt_data.${s.kind}`,
        "alt_data",
        "neutral",
        s.inputs.read,
        s.value,
        s.inputs.evidence.slice(0, 5).map((e) => `${e.kind}:${e.id}`),
      ),
    );
}

export function computeRuleInsights(i: CompanyInputs): RuleInsight[] {
  const out: Array<RuleInsight | null> = [
    dist52w(i),
    maRegime(i),
    relNifty(i),
    growthVsSector(i),
    marginVsSector(i),
    cagr3y(i),
    marginTrend(i),
    leverage(i),
    cashConversion(i),
    qualityScore(i),
    holdingChange(i, "promoter"),
    holdingChange(i, "fii"),
    holdingChange(i, "dii"),
    pledge(i),
    upside(i),
    skew(i),
    revision(i),
    surpriseStreak(i),
    concentration(i),
    scMomentum(i),
    distress(i),
    ...altData(i),
  ];
  return out.filter((r): r is RuleInsight => r != null);
}
