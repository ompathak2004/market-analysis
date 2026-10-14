import { isRoutineAnnouncement, median } from "@ma/core";
import {
  analystCalls,
  analystRatings,
  and,
  announcements,
  companies,
  companyFacts,
  consensusHistory,
  type Db,
  desc,
  documents,
  earningsEstimates,
  earningsSurprises,
  eq,
  fundamentals,
  gte,
  inArray,
  indexPricesDaily,
  indices,
  insights,
  isNull,
  lte,
  pricesDaily,
  priceTargets,
  relationshipEstimates,
  relationships,
  shareholding,
  signals,
  sql,
} from "@ma/db";
import type { AltdataSignal } from "../altdata/types.js";
import { dupont } from "../risk.js";
import { computeRuleInsights } from "./rules.js";
import {
  type BrokerThesis,
  brokerThesisSchema,
  companyBriefSchema,
  type Evidence,
  type RuleInsight,
  type VerdictLabel,
} from "./schemas.js";

const DAY_MS = 86_400_000;

export interface CompanyRef {
  id: number;
  symbol: string;
  name: string;
  sector: string | null;
  industry: string | null;
  marketCapCr: number | null;
}

export interface PriceStats {
  last: number;
  asOf: string;
  chg1dPct: number | null;
  chg1mPct: number | null;
  chg3mPct: number | null;
  chg1yPct: number | null;
  high52w: number | null;
  low52w: number | null;
  distToHighPct: number | null;
  distToLowPct: number | null;
  dma50: number | null;
  dma200: number | null;
  cross: { kind: "golden" | "death"; sessionsAgo: number } | null;
  relVsNifty1mPct: number | null;
  relVsNifty3mPct: number | null;
}

export interface AnnualRow {
  periodEnd: string;
  revenue: number | null;
  operatingProfit: number | null;
  netIncome: number | null;
  pretaxIncome: number | null;
  totalDebt: number | null;
  totalEquity: number | null;
  totalAssets: number | null;
  currentAssets: number | null;
  currentLiabilities: number | null;
  cashFromOps: number | null;
  interestExpense: number | null;
}

export interface QuarterRow {
  periodEnd: string;
  revenue: number | null;
  operatingProfit: number | null;
  netIncome: number | null;
  opmPct: number | null;
}

export interface FundamentalsBlock {
  unit: "INR crore";
  annual: AnnualRow[];
  quarterly: QuarterRow[];
  growth: {
    revenueYoyPct: number | null;
    patYoyPct: number | null;
    quarterRevenueYoyPct: number | null;
    quarterPatYoyPct: number | null;
    revenueCagr3yPct: number | null;
    patCagr3yPct: number | null;
  };
  ratios: {
    opmPct: number | null;
    debtToEquity: number | null;
    interestCover: number | null;
    roePct: number | null;
    cashConversion3y: number | null;
  };
  sectorMedians: {
    sector: string;
    peers: number;
    revenueYoyPct: number | null;
    patYoyPct: number | null;
    opmPct: number | null;
    debtToEquity: number | null;
  } | null;
}

export interface ShareholdingBlock {
  latestQuarter: string;
  previousQuarter: string | null;
  promoterPct: number | null;
  fiiPct: number | null;
  diiPct: number | null;
  publicPct: number | null;
  pledgePct: number | null;
  qoq: { promoter: number | null; fii: number | null; dii: number | null };
}

export interface ConsensusBlock {
  asOf: string | null;
  analystCount: number | null;
  buyPct: number | null;
  holdPct: number | null;
  sellPct: number | null;
  finalRating: string | null;
  targetLow: number | null;
  targetMean: number | null;
  targetHigh: number | null;
  upsideToMeanPct: number | null;
  epsNextFyAvg: number | null;
  epsNextFyRevision30dPct: number | null;
  countsTrend: Array<{ month: string; buy: number; hold: number; sell: number }>;
  surprises: Array<{
    quarterEnd: string;
    metric: string;
    outcome: string;
    surprisePct: number | null;
  }>;
}

export interface BrokerView {
  id: number;
  evidenceId: string;
  broker: string;
  publishedAt: string;
  rating: string;
  action: string;
  target: number | null;
  priorTarget: number | null;
  priceAtCall: number | null;
  title: string | null;
  stance: BrokerThesis["stance"] | null;
  keyPoints: string[];
  targetBasis: string | null;
}

export interface CounterpartyView {
  name: string;
  symbol: string | null;
  pct: number | null;
  method: string | null;
  evidenceId: string;
}

export interface SupplyChainBlock {
  customers: CounterpartyView[];
  suppliers: CounterpartyView[];
  signals: {
    customerConcentrationPct: number | null;
    customerHhi: number | null;
    customerMomentum3mPct: number | null;
    supplierMomentum3mPct: number | null;
    distressScore: number | null;
  };
}

export interface AnnouncementView {
  id: number;
  evidenceId: string;
  publishedAt: string;
  subject: string;
  materiality: string | null;
  category: string | null;
  soWhat: string | null;
}

export interface FactsBlock {
  stockScore: number | null;
  verdict: string | null;
  swotCounts: { strength: number; weakness: number; opportunity: number; threat: number } | null;
}

export interface PreviousBrief {
  generatedAt: string;
  verdict: { score: number; label: VerdictLabel; confidence: number };
  thesis: string[];
}

export interface CompanyInputs {
  asOf: string;
  company: CompanyRef;
  price: PriceStats | null;
  fundamentals: FundamentalsBlock | null;
  shareholding: ShareholdingBlock | null;
  consensus: ConsensusBlock | null;
  brokers: BrokerView[];
  supplyChain: SupplyChainBlock | null;
  announcements: AnnouncementView[];
  travel: AltdataSignal[] | null;
  logistics: AltdataSignal[] | null;
  ruleInsights: RuleInsight[];
  facts: FactsBlock | null;
  previousBrief: PreviousBrief | null;
  evidence: Evidence[];
}

const num = (v: string | number | null | undefined): number | null => {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

export const round = (v: number | null, digits = 1): number | null => {
  if (v == null || !Number.isFinite(v)) return null;
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};

const pctChange = (now: number | null, then: number | null): number | null =>
  now == null || then == null || then === 0 ? null : ((now - then) / Math.abs(then)) * 100;

const cagrPct = (now: number | null, then: number | null, years: number): number | null =>
  now == null || then == null || now <= 0 || then <= 0
    ? null
    : ((now / then) ** (1 / years) - 1) * 100;

const shiftIso = (date: string, days: number): string =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

export interface DailyBar {
  date: string;
  close: number;
  high: number | null;
  low: number | null;
}

function closeOnOrBefore(bars: DailyBar[], date: string): number | null {
  let best: number | null = null;
  for (const b of bars) {
    if (b.date <= date) best = b.close;
    else break;
  }
  return best;
}

function sma(closes: number[], end: number, window: number): number | null {
  if (end + 1 < window) return null;
  let s = 0;
  for (let i = end - window + 1; i <= end; i++) s += closes[i] as number;
  return s / window;
}

export function computePriceStats(
  bars: DailyBar[],
  index: DailyBar[] | null,
  crossLookback = 20,
): PriceStats | null {
  const last = bars.at(-1);
  if (!last) return null;
  const asOf = last.date;
  const prev = bars.at(-2);
  const ret = (days: number) => pctChange(last.close, closeOnOrBefore(bars, shiftIso(asOf, -days)));
  const yearAgo = shiftIso(asOf, -365);
  const window = bars.filter((b) => b.date > yearAgo);
  const high52w = window.length ? Math.max(...window.map((b) => b.high ?? b.close)) : null;
  const low52w = window.length ? Math.min(...window.map((b) => b.low ?? b.close)) : null;
  const closes = bars.map((b) => b.close);
  const end = closes.length - 1;
  let cross: PriceStats["cross"] = null;
  for (let k = 0; k < crossLookback && end - k - 1 >= 0; k++) {
    const f1 = sma(closes, end - k, 50);
    const s1 = sma(closes, end - k, 200);
    const f0 = sma(closes, end - k - 1, 50);
    const s0 = sma(closes, end - k - 1, 200);
    if (f1 == null || s1 == null || f0 == null || s0 == null) break;
    if (f0 <= s0 && f1 > s1) {
      cross = { kind: "golden", sessionsAgo: k };
      break;
    }
    if (f0 >= s0 && f1 < s1) {
      cross = { kind: "death", sessionsAgo: k };
      break;
    }
  }
  const idxRet = (days: number) => {
    if (!index?.length) return null;
    const lastIdx = closeOnOrBefore(index, asOf);
    return pctChange(lastIdx, closeOnOrBefore(index, shiftIso(asOf, -days)));
  };
  const rel = (days: number) => {
    const a = ret(days);
    const b = idxRet(days);
    return a == null || b == null ? null : a - b;
  };
  return {
    last: round(last.close, 2) as number,
    asOf,
    chg1dPct: round(prev ? pctChange(last.close, prev.close) : null),
    chg1mPct: round(ret(30)),
    chg3mPct: round(ret(91)),
    chg1yPct: round(ret(365)),
    high52w: round(high52w, 2),
    low52w: round(low52w, 2),
    distToHighPct: round(pctChange(last.close, high52w)),
    distToLowPct: round(pctChange(last.close, low52w)),
    dma50: round(sma(closes, end, 50), 2),
    dma200: round(sma(closes, end, 200), 2),
    cross,
    relVsNifty1mPct: round(rel(30)),
    relVsNifty3mPct: round(rel(91)),
  };
}

export function computeFundamentals(
  annual: AnnualRow[],
  quarterly: QuarterRow[],
  sectorMedians: FundamentalsBlock["sectorMedians"],
): FundamentalsBlock | null {
  if (!annual.length && !quarterly.length) return null;
  const [a0, a1] = annual;
  const a3 = annual[3];
  const q0 = quarterly[0];
  const q4 = quarterly[4];
  const ratios = a0 ? dupont(a0) : null;
  const last3 = annual.slice(0, 3);
  const cfo = last3.reduce((s, r) => s + (r.cashFromOps ?? 0), 0);
  const pat = last3.reduce((s, r) => s + (r.netIncome ?? 0), 0);
  const cfoComplete = last3.length === 3 && last3.every((r) => r.cashFromOps != null);
  return {
    unit: "INR crore",
    annual: annual.slice(0, 4),
    quarterly: quarterly.slice(0, 6),
    growth: {
      revenueYoyPct: round(pctChange(a0?.revenue ?? null, a1?.revenue ?? null)),
      patYoyPct: round(pctChange(a0?.netIncome ?? null, a1?.netIncome ?? null)),
      quarterRevenueYoyPct: round(pctChange(q0?.revenue ?? null, q4?.revenue ?? null)),
      quarterPatYoyPct: round(pctChange(q0?.netIncome ?? null, q4?.netIncome ?? null)),
      revenueCagr3yPct: round(cagrPct(a0?.revenue ?? null, a3?.revenue ?? null, 3)),
      patCagr3yPct: round(cagrPct(a0?.netIncome ?? null, a3?.netIncome ?? null, 3)),
    },
    ratios: {
      opmPct: round(ratios?.operatingMargin != null ? ratios.operatingMargin * 100 : null),
      debtToEquity: round(ratios?.debtToEquity ?? null, 2),
      interestCover: round(ratios?.interestCoverage ?? null),
      roePct: round(ratios?.roe != null ? ratios.roe * 100 : null),
      cashConversion3y: cfoComplete && pat > 0 ? round(cfo / pat, 2) : null,
    },
    sectorMedians,
  };
}

const evidence = (
  list: Evidence[],
  id: string,
  kind: Evidence["kind"],
  label: string,
  url: string | null,
): string => {
  if (!list.some((e) => e.id === id)) list.push({ id, kind, label, url });
  return id;
};

async function loadCompany(
  db: Db,
  companyId: number,
): Promise<CompanyRef & { screenerSlug: string | null; moneycontrolUrl: string | null }> {
  const c = await db.query.companies.findFirst({ where: eq(companies.id, companyId) });
  if (!c) throw new Error(`company ${companyId} not found`);
  return {
    id: c.id,
    symbol: c.nseSymbol ?? c.name,
    name: c.name,
    sector: c.sector ?? null,
    industry: c.industry ?? null,
    marketCapCr: round(num(c.marketCapCr), 0),
    screenerSlug: c.screenerSlug ?? null,
    moneycontrolUrl: c.moneycontrolUrl ?? null,
  };
}

async function loadBars(db: Db, companyId: number, asOf: string): Promise<DailyBar[]> {
  const rows = await db
    .select({
      date: pricesDaily.date,
      close: pricesDaily.close,
      high: pricesDaily.high,
      low: pricesDaily.low,
    })
    .from(pricesDaily)
    .where(
      and(
        eq(pricesDaily.companyId, companyId),
        lte(pricesDaily.date, asOf),
        gte(pricesDaily.date, shiftIso(asOf, -400)),
      ),
    )
    .orderBy(pricesDaily.date);
  return rows.map((r) => ({
    date: r.date,
    close: r.close,
    high: r.high ?? null,
    low: r.low ?? null,
  }));
}

export async function loadIndexBars(
  db: Db,
  code: string,
  asOf: string,
): Promise<DailyBar[] | null> {
  const rows = await db
    .select({
      date: indexPricesDaily.date,
      close: indexPricesDaily.close,
      high: indexPricesDaily.high,
      low: indexPricesDaily.low,
    })
    .from(indexPricesDaily)
    .innerJoin(indices, eq(indices.id, indexPricesDaily.indexId))
    .where(
      and(
        eq(indices.code, code),
        lte(indexPricesDaily.date, asOf),
        gte(indexPricesDaily.date, shiftIso(asOf, -400)),
      ),
    )
    .orderBy(indexPricesDaily.date);
  return rows.length
    ? rows.map((r) => ({ date: r.date, close: r.close, high: r.high ?? null, low: r.low ?? null }))
    : null;
}

async function loadFundamentals(
  db: Db,
  company: CompanyRef,
  asOf: string,
): Promise<{ block: FundamentalsBlock | null; documentUrl: string | null }> {
  const rows = await db
    .select({ f: fundamentals, url: documents.url })
    .from(fundamentals)
    .leftJoin(documents, eq(documents.id, fundamentals.sourceDocumentId))
    .where(and(eq(fundamentals.companyId, company.id), lte(fundamentals.periodEnd, asOf)))
    .orderBy(desc(fundamentals.periodEnd));
  const annual: AnnualRow[] = rows
    .filter((r) => r.f.periodType === "annual")
    .slice(0, 4)
    .map(({ f }) => ({
      periodEnd: f.periodEnd,
      revenue: num(f.revenue),
      operatingProfit: num(f.operatingProfit),
      netIncome: num(f.netIncome),
      pretaxIncome: num(f.pretaxIncome),
      totalDebt: num(f.totalDebt),
      totalEquity: num(f.totalEquity),
      totalAssets: num(f.totalAssets),
      currentAssets: num(f.currentAssets),
      currentLiabilities: num(f.currentLiabilities),
      cashFromOps: num(f.cashFromOps),
      interestExpense: num(f.interestExpense),
    }));
  const quarterly: QuarterRow[] = rows
    .filter((r) => r.f.periodType === "quarterly")
    .slice(0, 6)
    .map(({ f }) => {
      const revenue = num(f.revenue);
      const op = num(f.operatingProfit);
      return {
        periodEnd: f.periodEnd,
        revenue,
        operatingProfit: op,
        netIncome: num(f.netIncome),
        opmPct: round(revenue && op != null ? (op / revenue) * 100 : null),
      };
    });
  const sectorMedians = company.sector ? await loadSectorMedians(db, company.sector, asOf) : null;
  return {
    block: computeFundamentals(annual, quarterly, sectorMedians),
    documentUrl: rows[0]?.url ?? null,
  };
}

async function loadSectorMedians(
  db: Db,
  sector: string,
  asOf: string,
): Promise<FundamentalsBlock["sectorMedians"]> {
  const rows = await db.execute<{
    rev: string | null;
    pat: string | null;
    op: string | null;
    debt: string | null;
    eq: string | null;
    prev_rev: string | null;
    prev_pat: string | null;
  }>(sql`
    with ranked as (
      select f.company_id, f.revenue rev, f.net_income pat, f.operating_profit op, f.total_debt debt, f.total_equity eq,
             row_number() over (partition by f.company_id order by f.period_end desc) rn
      from fundamentals f join companies c on c.id = f.company_id
      where f.period_type = 'annual' and c.sector = ${sector} and f.period_end <= ${asOf}
    )
    select a.rev, a.pat, a.op, a.debt, a.eq, b.rev prev_rev, b.pat prev_pat
    from ranked a left join ranked b on b.company_id = a.company_id and b.rn = 2
    where a.rn = 1`);
  if (rows.length < 3) return null;
  const list = [...rows];
  return {
    sector,
    peers: list.length,
    revenueYoyPct: round(median(list.map((r) => pctChange(num(r.rev), num(r.prev_rev))))),
    patYoyPct: round(median(list.map((r) => pctChange(num(r.pat), num(r.prev_pat))))),
    opmPct: round(
      median(
        list.map((r) => {
          const rev = num(r.rev);
          const op = num(r.op);
          return rev && op != null ? (op / rev) * 100 : null;
        }),
      ),
    ),
    debtToEquity: round(
      median(
        list.map((r) => {
          const d = num(r.debt);
          const e = num(r.eq);
          return d != null && e ? d / e : null;
        }),
      ),
      2,
    ),
  };
}

async function loadShareholding(
  db: Db,
  companyId: number,
  asOf: string,
): Promise<ShareholdingBlock | null> {
  const rows = await db
    .select()
    .from(shareholding)
    .where(and(eq(shareholding.companyId, companyId), lte(shareholding.quarterEnd, asOf)))
    .orderBy(desc(shareholding.quarterEnd))
    .limit(15);
  const quarters = [...new Set(rows.map((r) => r.quarterEnd))];
  const [latest, previous] = quarters;
  if (!latest) return null;
  const pick = (q: string | undefined, holder: string) =>
    q ? (rows.find((r) => r.quarterEnd === q && r.holder === holder) ?? null) : null;
  const pct = (q: string | undefined, holder: string) => round(pick(q, holder)?.pct ?? null, 2);
  const delta = (holder: string) => {
    const a = pct(latest, holder);
    const b = pct(previous, holder);
    return a == null || b == null ? null : round(a - b, 2);
  };
  return {
    latestQuarter: latest,
    previousQuarter: previous ?? null,
    promoterPct: pct(latest, "promoter"),
    fiiPct: pct(latest, "fii"),
    diiPct: pct(latest, "dii"),
    publicPct: pct(latest, "public"),
    pledgePct: round(pick(latest, "promoter")?.pledgePct ?? null, 2),
    qoq: { promoter: delta("promoter"), fii: delta("fii"), dii: delta("dii") },
  };
}

async function loadConsensus(
  db: Db,
  companyId: number,
  asOf: string,
  last: number | null,
): Promise<ConsensusBlock | null> {
  const [rating] = await db
    .select()
    .from(analystRatings)
    .where(and(eq(analystRatings.companyId, companyId), lte(analystRatings.asOf, asOf)))
    .orderBy(desc(analystRatings.asOf))
    .limit(1);
  const [target] = await db
    .select()
    .from(priceTargets)
    .where(and(eq(priceTargets.companyId, companyId), lte(priceTargets.asOf, asOf)))
    .orderBy(desc(priceTargets.asOf))
    .limit(1);
  const eps = await db
    .select()
    .from(earningsEstimates)
    .where(
      and(
        eq(earningsEstimates.companyId, companyId),
        eq(earningsEstimates.metric, "eps"),
        sql`${earningsEstimates.fiscalYearEnd} > ${asOf}`,
        lte(earningsEstimates.asOf, asOf),
      ),
    )
    .orderBy(
      earningsEstimates.fiscalYearEnd,
      desc(earningsEstimates.consolidated),
      desc(earningsEstimates.asOf),
    )
    .limit(60);
  const history = await db
    .select()
    .from(consensusHistory)
    .where(and(eq(consensusHistory.companyId, companyId), lte(consensusHistory.month, asOf)))
    .orderBy(desc(consensusHistory.month))
    .limit(5);
  const surpriseRows = await db
    .select()
    .from(earningsSurprises)
    .where(and(eq(earningsSurprises.companyId, companyId), lte(earningsSurprises.quarterEnd, asOf)))
    .orderBy(desc(earningsSurprises.quarterEnd))
    .limit(12);
  if (!rating && !target && !eps.length && !history.length && !surpriseRows.length) return null;
  const nextFy = eps[0]?.fiscalYearEnd;
  const series = eps.filter(
    (e) => e.fiscalYearEnd === nextFy && e.consolidated === eps[0]?.consolidated,
  );
  const current = series[0];
  const prior = current ? series.find((e) => e.asOf <= shiftIso(current.asOf, -30)) : undefined;
  const surpriseMetric = surpriseRows.some((s) => s.metric === "eps")
    ? "eps"
    : surpriseRows[0]?.metric;
  const mean = target?.mean ?? null;
  const sum = (...v: Array<number | null | undefined>) =>
    v.some((x) => x != null) ? v.reduce<number>((s, x) => s + (x ?? 0), 0) : null;
  return {
    asOf: rating?.asOf ?? target?.asOf ?? current?.asOf ?? null,
    analystCount: rating?.analystCount ?? null,
    buyPct: round(sum(rating?.buyPct, rating?.outperformPct)),
    holdPct: round(rating?.holdPct ?? null),
    sellPct: round(sum(rating?.underperformPct, rating?.sellPct)),
    finalRating: rating?.finalRating ?? null,
    targetLow: round(target?.low ?? null, 2),
    targetMean: round(mean, 2),
    targetHigh: round(target?.high ?? null, 2),
    upsideToMeanPct: round(pctChange(mean, last)),
    epsNextFyAvg: round(num(current?.avg), 2),
    epsNextFyRevision30dPct: round(pctChange(num(current?.avg), num(prior?.avg))),
    countsTrend: history
      .map((h) => ({
        month: h.month,
        buy: (h.buy ?? 0) + (h.outperform ?? 0),
        hold: h.hold ?? 0,
        sell: (h.sell ?? 0) + (h.underperform ?? 0),
      }))
      .reverse(),
    surprises: surpriseRows
      .filter((s) => s.metric === surpriseMetric)
      .slice(0, 4)
      .map((s) => ({
        quarterEnd: s.quarterEnd,
        metric: s.metric,
        outcome: s.outcome,
        surprisePct: round(s.surprisePct ?? null),
      })),
  };
}

async function loadBrokers(
  db: Db,
  companyId: number,
  asOf: string,
  ev: Evidence[],
): Promise<BrokerView[]> {
  const rows = await db
    .select()
    .from(analystCalls)
    .where(and(eq(analystCalls.companyId, companyId), lte(analystCalls.publishedAt, asOf)))
    .orderBy(desc(analystCalls.publishedAt), desc(analystCalls.id))
    .limit(8);
  return rows.map((r) => {
    const thesis = r.thesis ? brokerThesisSchema.safeParse(r.thesis) : null;
    const t = thesis?.success ? thesis.data : null;
    const evidenceId = evidence(
      ev,
      `brk:${r.id}`,
      "broker_pdf",
      `${r.broker} ${r.rating}${r.targetPrice ? ` TP ${r.targetPrice}` : ""} (${r.publishedAt})`,
      r.reportUrl ?? null,
    );
    return {
      id: r.id,
      evidenceId,
      broker: r.broker,
      publishedAt: r.publishedAt,
      rating: r.rating,
      action: r.action,
      target: round(r.targetPrice ?? null, 2),
      priorTarget: round(r.priorTargetPrice ?? null, 2),
      priceAtCall: round(r.priceAtCall ?? null, 2),
      title: r.title ?? null,
      stance: t?.stance ?? null,
      keyPoints: t?.keyPoints.slice(0, 3) ?? [],
      targetBasis: t?.targetBasis ?? null,
    };
  });
}

async function loadSupplyChain(
  db: Db,
  companyId: number,
  asOf: string,
  ev: Evidence[],
): Promise<SupplyChainBlock | null> {
  const rows = await db
    .select({
      id: relationships.id,
      supplierCompanyId: relationships.supplierCompanyId,
      supplierName: relationships.supplierName,
      customerCompanyId: relationships.customerCompanyId,
      customerName: relationships.customerName,
      disclosedPct: relationships.disclosedPct,
      disclosureKind: relationships.disclosureKind,
      confidence: relationships.confidence,
      method: relationshipEstimates.method,
      supplierRevenuePct: relationshipEstimates.supplierRevenuePct,
      customerCostPct: relationshipEstimates.customerCostPct,
      docUrl: documents.url,
      docSource: documents.source,
    })
    .from(relationships)
    .leftJoin(
      relationshipEstimates,
      sql`${relationshipEstimates.relationshipId} = ${relationships.id} and ${relationshipEstimates.id} = (select id from relationship_estimates re where re.relationship_id = ${relationships.id} order by as_of desc, model_version desc limit 1)`,
    )
    .leftJoin(documents, eq(documents.id, relationships.sourceDocumentId))
    .where(
      sql`(${relationships.supplierCompanyId} = ${companyId} or ${relationships.customerCompanyId} = ${companyId}) and ${relationships.validTo} >= ${asOf} and ${relationships.status} in ('active', 'expired')`,
    )
    .orderBy(desc(relationshipEstimates.supplierRevenuePct), desc(relationships.confidence));
  const otherIds = [
    ...new Set(
      rows
        .flatMap((r) => [r.supplierCompanyId, r.customerCompanyId])
        .filter((id): id is number => id != null && id !== companyId),
    ),
  ];
  const symbols = otherIds.length
    ? await db
        .select({ id: companies.id, symbol: companies.nseSymbol })
        .from(companies)
        .where(inArray(companies.id, otherIds))
    : [];
  const symbolOf = new Map(symbols.map((s) => [s.id, s.symbol ?? null]));
  const view = (r: (typeof rows)[number], asCustomer: boolean): CounterpartyView => {
    const name = asCustomer ? r.customerName : r.supplierName;
    const otherId = asCustomer ? r.customerCompanyId : r.supplierCompanyId;
    const kind = r.docSource === "concall" ? "concall" : r.docUrl ? "filing" : "source";
    return {
      name,
      symbol: otherId ? (symbolOf.get(otherId) ?? null) : null,
      pct: round(
        asCustomer ? (r.disclosedPct ?? r.supplierRevenuePct ?? null) : (r.customerCostPct ?? null),
      ),
      method: r.method ?? r.disclosureKind,
      evidenceId: evidence(
        ev,
        `rel:${r.id}`,
        kind,
        `${r.supplierName} supplies ${r.customerName} (${r.disclosureKind})`,
        r.docUrl ?? null,
      ),
    };
  };
  const customers = rows
    .filter((r) => r.supplierCompanyId === companyId)
    .slice(0, 5)
    .map((r) => view(r, true));
  const suppliers = rows
    .filter((r) => r.customerCompanyId === companyId)
    .slice(0, 5)
    .map((r) => view(r, false));
  const kinds = [
    "customer_concentration_pct",
    "customer_hhi",
    "customer_momentum_3m",
    "supplier_momentum_3m",
    "distress_score",
  ];
  const sig = await db
    .selectDistinctOn([signals.kind], {
      kind: signals.kind,
      value: signals.value,
      asOf: signals.asOf,
    })
    .from(signals)
    .where(
      and(eq(signals.companyId, companyId), inArray(signals.kind, kinds), lte(signals.asOf, asOf)),
    )
    .orderBy(signals.kind, desc(signals.asOf), desc(signals.modelVersion));
  const v = (k: string, digits: number) =>
    round(sig.find((s) => s.kind === k)?.value ?? null, digits);
  const block: SupplyChainBlock = {
    customers,
    suppliers,
    signals: {
      customerConcentrationPct: v("customer_concentration_pct", 1),
      customerHhi: v("customer_hhi", 2),
      customerMomentum3mPct: v("customer_momentum_3m", 1),
      supplierMomentum3mPct: v("supplier_momentum_3m", 1),
      distressScore: v("distress_score", 2),
    },
  };
  if (sig.length)
    evidence(
      ev,
      "sig:supply_chain",
      "source",
      "Supply-chain and distress signals (our models)",
      null,
    );
  const empty =
    !customers.length && !suppliers.length && Object.values(block.signals).every((x) => x == null);
  return empty ? null : block;
}

async function loadAnnouncements(
  db: Db,
  companyId: number,
  asOf: string,
  ev: Evidence[],
): Promise<AnnouncementView[]> {
  const rows = await db
    .select()
    .from(announcements)
    .where(
      and(
        eq(announcements.companyId, companyId),
        sql`${announcements.publishedAt} < ${shiftIso(asOf, 1)}`,
      ),
    )
    .orderBy(desc(announcements.publishedAt))
    .limit(60);
  return rows
    .filter(
      (r) =>
        r.triageCategory !== "routine" &&
        !(r.triageCategory == null && isRoutineAnnouncement(r.subject, r.details)),
    )
    .slice(0, 10)
    .map((r) => {
      const date = r.publishedAt.toISOString().slice(0, 10);
      return {
        id: r.id,
        evidenceId: evidence(
          ev,
          `ann:${r.id}`,
          "announcement",
          `${date} ${r.subject}`.slice(0, 140),
          r.attachmentUrl ?? null,
        ),
        publishedAt: date,
        subject: r.subject.slice(0, 160),
        materiality: r.materiality ?? null,
        category: r.triageCategory ?? null,
        soWhat: r.soWhat ?? r.details?.slice(0, 200) ?? null,
      };
    });
}

async function loadAltdata(
  db: Db,
  companyId: number,
  asOf: string,
  ev: Evidence[],
): Promise<{ travel: AltdataSignal[] | null; logistics: AltdataSignal[] | null }> {
  const yesterday = shiftIso(asOf, -1);
  const rows = await db
    .select()
    .from(signals)
    .where(
      and(
        eq(signals.companyId, companyId),
        sql`(${signals.kind} like 'travel\\_%' or ${signals.kind} like 'logistics\\_%')`,
        gte(signals.asOf, yesterday),
        lte(signals.asOf, asOf),
      ),
    );
  const day = rows.some((r) => r.asOf === asOf) ? asOf : yesterday;
  const newest = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    if (r.asOf !== day) continue;
    const seen = newest.get(r.kind);
    if (!seen || r.modelVersion > seen.modelVersion) newest.set(r.kind, r);
  }
  const pick = (prefix: string): AltdataSignal[] | null => {
    const list = [...newest.values()]
      .filter((r) => r.kind.startsWith(prefix))
      .sort((a, b) => a.kind.localeCompare(b.kind))
      .map((r) => {
        const inputs = r.inputs as AltdataSignal["inputs"];
        const evList = Array.isArray(inputs.evidence) ? inputs.evidence.slice(0, 5) : [];
        for (const e of evList)
          evidence(ev, `${e.kind}:${e.id}`, "altdata", e.label, e.url ?? null);
        return {
          kind: r.kind as AltdataSignal["kind"],
          asOf: r.asOf,
          value: round(r.value, 2),
          inputs: {
            read: String(inputs.read ?? ""),
            confidence: round(num(inputs.confidence as number) ?? 0, 2) as number,
            evidence: evList,
            window: inputs.window,
          },
        };
      });
    return list.length ? list : null;
  };
  return { travel: pick("travel_"), logistics: pick("logistics_") };
}

async function loadFacts(db: Db, companyId: number): Promise<FactsBlock | null> {
  const row = await db.query.companyFacts.findFirst({
    where: and(eq(companyFacts.companyId, companyId), eq(companyFacts.source, "moneycontrol")),
  });
  if (!row) return null;
  const f = row.facts as Record<string, unknown>;
  const swot = (f.swot ?? null) as Record<string, { count?: unknown } | number | null> | null;
  const count = (k: string) => {
    const v = swot?.[k];
    return typeof v === "number" ? v : (num((v as { count?: number } | null)?.count ?? null) ?? 0);
  };
  return {
    stockScore: num((f.stockScore as number | string | null) ?? null),
    verdict: typeof f.verdict === "string" ? f.verdict : null,
    swotCounts: swot
      ? {
          strength: count("strength"),
          weakness: count("weakness"),
          opportunity: count("opportunity"),
          threat: count("threat"),
        }
      : null,
  };
}

export async function currentInsight(db: Db, kind: string, companyId: number | null) {
  const rows = await db
    .select()
    .from(insights)
    .where(
      and(
        eq(insights.kind, kind),
        companyId == null ? isNull(insights.companyId) : eq(insights.companyId, companyId),
        isNull(insights.supersededAt),
      ),
    )
    .orderBy(desc(insights.generatedAt))
    .limit(1);
  return rows[0] ?? null;
}

async function loadPreviousBrief(db: Db, companyId: number): Promise<PreviousBrief | null> {
  const row = await currentInsight(db, "company_brief", companyId);
  const parsed = row ? companyBriefSchema.safeParse(row.output) : null;
  if (!row || !parsed?.success) return null;
  const { score, label, confidence } = parsed.data.verdict;
  return {
    generatedAt: row.generatedAt.toISOString(),
    verdict: { score, label, confidence },
    thesis: parsed.data.thesis.map((t) => t.point),
  };
}

export async function assembleCompanyInputs(
  db: Db,
  companyId: number,
  asOf: string,
): Promise<CompanyInputs> {
  const ev: Evidence[] = [];
  const company = await loadCompany(db, companyId);
  const [bars, nifty] = await Promise.all([
    loadBars(db, companyId, asOf),
    loadIndexBars(db, "NIFTY50", asOf),
  ]);
  const price = computePriceStats(bars, nifty);
  if (price) evidence(ev, "px", "source", `Daily prices to ${price.asOf}`, null);
  const fin = await loadFundamentals(db, company, asOf);
  if (fin.block) {
    evidence(
      ev,
      "fin",
      "filing",
      "Reported financials (annual and quarterly)",
      fin.documentUrl ??
        (company.screenerSlug
          ? `https://www.screener.in/company/${company.screenerSlug}/consolidated/`
          : null),
    );
  }
  const holding = await loadShareholding(db, companyId, asOf);
  if (holding)
    evidence(
      ev,
      "shp",
      "source",
      `Shareholding pattern ${holding.latestQuarter}`,
      company.moneycontrolUrl,
    );
  const consensus = await loadConsensus(db, companyId, asOf, price?.last ?? null);
  if (consensus)
    evidence(ev, "cns", "source", "Analyst consensus and estimates", company.moneycontrolUrl);
  const brokers = await loadBrokers(db, companyId, asOf, ev);
  const supplyChain = await loadSupplyChain(db, companyId, asOf, ev);
  const ann = await loadAnnouncements(db, companyId, asOf, ev);
  const alt = await loadAltdata(db, companyId, asOf, ev);
  const facts = await loadFacts(db, companyId);
  if (facts)
    evidence(ev, "facts", "source", "Moneycontrol stock score and SWOT", company.moneycontrolUrl);
  const previousBrief = await loadPreviousBrief(db, companyId);
  if (previousBrief)
    evidence(ev, "prev", "source", `Previous brief (${previousBrief.generatedAt})`, null);
  const { screenerSlug: _s, moneycontrolUrl: _m, ...ref } = company;
  const inputs: CompanyInputs = {
    asOf,
    company: ref,
    price,
    fundamentals: fin.block,
    shareholding: holding,
    consensus,
    brokers,
    supplyChain,
    announcements: ann,
    travel: alt.travel,
    logistics: alt.logistics,
    ruleInsights: [],
    facts,
    previousBrief,
    evidence: ev,
  };
  inputs.ruleInsights = computeRuleInsights(inputs);
  return inputs;
}

export interface MarketIndexQuote {
  code: string;
  name: string;
  last: number;
  chg1dPct: number | null;
  chg1wPct: number | null;
}

export interface MarketMover {
  symbol: string;
  name: string;
  sector: string | null;
  last: number;
  chg1dPct: number;
  evidenceId: string;
}

export interface MarketInputs {
  asOf: string;
  indices: MarketIndexQuote[];
  breadth: {
    universe: string;
    sample: number;
    advancers: number;
    decliners: number;
    unchanged: number;
    above50dmaPct: number | null;
    above200dmaPct: number | null;
  } | null;
  sectors: Array<{
    sector: string;
    companies: number;
    median1dPct: number | null;
    median1wPct: number | null;
  }>;
  movers: { gainers: MarketMover[]; losers: MarketMover[] };
  brokerCalls: Array<{
    symbol: string;
    broker: string;
    action: string;
    rating: string;
    target: number | null;
    evidenceId: string;
  }>;
  signalMovers: Array<{
    symbol: string;
    kind: string;
    value: number;
    change: number | null;
    evidenceId: string;
  }>;
  announcements: Array<{
    symbol: string;
    subject: string;
    category: string | null;
    soWhat: string | null;
    evidenceId: string;
  }>;
  evidence: Evidence[];
}

interface CloseRow {
  [k: string]: unknown;
  company_id: number;
  symbol: string | null;
  name: string;
  sector: string | null;
  last_date: string;
  last: number;
  prev: number | null;
  wk: number | null;
  sma50: number | null;
  sma200: number | null;
  in_breadth: boolean;
}

async function loadMarketCloses(db: Db, asOf: string, breadthIndex: string): Promise<CloseRow[]> {
  const rows = await db.execute<CloseRow>(sql`
    with b as (
      select p.company_id, p.date, p.close,
        row_number() over w_desc rn,
        avg(p.close) over (partition by p.company_id order by p.date rows between 49 preceding and current row) sma50,
        avg(p.close) over (partition by p.company_id order by p.date rows between 199 preceding and current row) sma200,
        count(*) over (partition by p.company_id order by p.date rows between 199 preceding and current row) n200
      from prices_daily p
      where p.date <= ${asOf} and p.date > ${shiftIso(asOf, -320)}
      window w_desc as (partition by p.company_id order by p.date desc)
    )
    select c.id company_id, c.nse_symbol symbol, c.name, c.sector,
      (max(b.date) filter (where b.rn = 1))::text last_date,
      max(b.close) filter (where b.rn = 1) last,
      max(b.close) filter (where b.rn = 2) prev,
      max(b.close) filter (where b.rn = 6) wk,
      max(b.sma50) filter (where b.rn = 1 and b.n200 >= 50) sma50,
      max(b.sma200) filter (where b.rn = 1 and b.n200 >= 200) sma200,
      exists (
        select 1 from index_constituents ic join indices i on i.id = ic.index_id
        where ic.company_id = c.id and i.code = ${breadthIndex}
      ) in_breadth
    from b join companies c on c.id = b.company_id
    where b.rn <= 6
    group by c.id`);
  const cutoff = shiftIso(asOf, -5);
  return [...rows].filter((r) => r.last_date >= cutoff && r.last != null);
}

export async function assembleMarketInputs(
  db: Db,
  asOf: string,
  breadthIndex = "NIFTY50",
): Promise<MarketInputs> {
  const ev: Evidence[] = [];
  const idxRows = await db.execute<{
    code: string;
    name: string;
    last: number;
    prev: number | null;
    wk: number | null;
  }>(sql`
    with r as (
      select i.code, i.name, p.close, row_number() over (partition by i.id order by p.date desc) rn
      from index_prices_daily p join indices i on i.id = p.index_id
      where p.date <= ${asOf} and p.date > ${shiftIso(asOf, -14)}
    )
    select code, name, max(close) filter (where rn = 1) last, max(close) filter (where rn = 2) prev,
      max(close) filter (where rn = 6) wk
    from r group by code, name order by code`);
  const indexQuotes: MarketIndexQuote[] = [...idxRows]
    .filter((r) => r.last != null)
    .map((r) => {
      evidence(ev, `idx:${r.code}`, "source", `${r.name} index closes`, null);
      return {
        code: r.code,
        name: r.name,
        last: round(r.last, 2) as number,
        chg1dPct: round(pctChange(r.last, r.prev)),
        chg1wPct: round(pctChange(r.last, r.wk)),
      };
    });

  const closes = await loadMarketCloses(db, asOf, breadthIndex);
  const withChg = closes.map((r) => ({
    ...r,
    chg1d: pctChange(r.last, r.prev),
    chg1w: pctChange(r.last, r.wk),
  }));
  const breadthSet = withChg.filter((r) => r.in_breadth);
  const breadthBase = breadthSet.length >= 5 ? breadthSet : withChg;
  let breadth: MarketInputs["breadth"] = null;
  if (breadthBase.length) {
    const share = (pred: (r: (typeof withChg)[number]) => boolean | null) => {
      const known = breadthBase.filter((r) => pred(r) != null);
      return known.length
        ? round((known.filter((r) => pred(r)).length / known.length) * 100)
        : null;
    };
    breadth = {
      universe: breadthBase === breadthSet ? breadthIndex : "covered companies",
      sample: breadthBase.length,
      advancers: breadthBase.filter((r) => (r.chg1d ?? 0) > 0).length,
      decliners: breadthBase.filter((r) => (r.chg1d ?? 0) < 0).length,
      unchanged: breadthBase.filter((r) => (r.chg1d ?? 0) === 0).length,
      above50dmaPct: share((r) => (r.sma50 == null ? null : r.last > r.sma50)),
      above200dmaPct: share((r) => (r.sma200 == null ? null : r.last > r.sma200)),
    };
    evidence(
      ev,
      "brd",
      "source",
      `Breadth across ${breadth.sample} ${breadth.universe} stocks`,
      null,
    );
  }

  const bySector = new Map<string, typeof withChg>();
  for (const r of withChg) {
    if (!r.sector) continue;
    const list = bySector.get(r.sector) ?? [];
    list.push(r);
    bySector.set(r.sector, list);
  }
  const sectors = [...bySector.entries()]
    .map(([sector, list]) => ({
      sector,
      companies: list.length,
      median1dPct: round(median(list.map((r) => r.chg1d))),
      median1wPct: round(median(list.map((r) => r.chg1w))),
    }))
    .sort((a, b) => (b.median1dPct ?? -999) - (a.median1dPct ?? -999))
    .slice(0, 14);
  if (sectors.length) evidence(ev, "sec", "source", "Sector median returns", null);

  const mover = (r: (typeof withChg)[number]): MarketMover => ({
    symbol: r.symbol ?? r.name,
    name: r.name,
    sector: r.sector,
    last: round(r.last, 2) as number,
    chg1dPct: round(r.chg1d) as number,
    evidenceId: evidence(
      ev,
      `mov:${r.symbol ?? r.company_id}`,
      "source",
      `${r.symbol ?? r.name} daily close`,
      null,
    ),
  });
  const ranked = withChg
    .filter((r) => r.chg1d != null)
    .sort((a, b) => (b.chg1d as number) - (a.chg1d as number));
  const gainers = ranked
    .filter((r) => (r.chg1d as number) > 0)
    .slice(0, 5)
    .map(mover);
  const losers = ranked
    .filter((r) => (r.chg1d as number) < 0)
    .reverse()
    .slice(0, 5)
    .map(mover);

  const since = shiftIso(asOf, -1);
  const calls = await db
    .select({
      id: analystCalls.id,
      symbol: companies.nseSymbol,
      name: companies.name,
      broker: analystCalls.broker,
      action: analystCalls.action,
      rating: analystCalls.rating,
      target: analystCalls.targetPrice,
      publishedAt: analystCalls.publishedAt,
      url: analystCalls.reportUrl,
    })
    .from(analystCalls)
    .innerJoin(companies, eq(companies.id, analystCalls.companyId))
    .where(and(gte(analystCalls.publishedAt, since), lte(analystCalls.publishedAt, asOf)))
    .orderBy(desc(analystCalls.publishedAt), desc(analystCalls.id))
    .limit(15);
  const brokerCalls = calls.map((c) => ({
    symbol: c.symbol ?? c.name,
    broker: c.broker,
    action: c.action,
    rating: c.rating,
    target: round(c.target ?? null, 2),
    evidenceId: evidence(
      ev,
      `brk:${c.id}`,
      "broker_pdf",
      `${c.broker} on ${c.symbol ?? c.name} (${c.publishedAt})`,
      c.url ?? null,
    ),
  }));

  const sigRows = await db.execute<{
    symbol: string | null;
    name: string;
    kind: string;
    value: number;
    prev: number | null;
  }>(sql`
    with latest as (
      select distinct on (s.company_id, s.kind) s.company_id, s.kind, s.model_version
      from signals s where s.kind in ('distress_score', 'customer_concentration_pct') and s.as_of <= ${asOf}
      order by s.company_id, s.kind, s.as_of desc, s.model_version desc
    ), r as (
      select s.company_id, s.kind, s.value, row_number() over (partition by s.company_id, s.kind order by s.as_of desc) rn
      from signals s join latest l on l.company_id = s.company_id and l.kind = s.kind and l.model_version = s.model_version
      where s.as_of <= ${asOf}
    )
    select c.nse_symbol symbol, c.name, a.kind, a.value, b.value prev
    from r a join companies c on c.id = a.company_id
    left join r b on b.company_id = a.company_id and b.kind = a.kind and b.rn = 2
    where a.rn = 1 and a.value is not null
    order by abs(coalesce(a.value - b.value, 0)) desc, a.value desc
    limit 8`);
  const signalMovers = [...sigRows].map((s) => ({
    symbol: s.symbol ?? s.name,
    kind: s.kind,
    value: round(s.value, 2) as number,
    change: s.prev == null ? null : round(s.value - s.prev, 2),
    evidenceId: evidence(
      ev,
      `sig:${s.kind}:${s.symbol ?? s.name}`,
      "source",
      `${s.symbol ?? s.name} ${s.kind}`,
      null,
    ),
  }));

  const annRows = await db
    .select({
      id: announcements.id,
      symbol: companies.nseSymbol,
      name: companies.name,
      subject: announcements.subject,
      category: announcements.triageCategory,
      soWhat: announcements.soWhat,
      url: announcements.attachmentUrl,
    })
    .from(announcements)
    .innerJoin(companies, eq(companies.id, announcements.companyId))
    .where(
      and(
        eq(announcements.materiality, "high"),
        gte(announcements.publishedAt, new Date(Date.parse(`${since}T00:00:00Z`))),
        sql`${announcements.publishedAt} < ${shiftIso(asOf, 1)}`,
      ),
    )
    .orderBy(desc(announcements.publishedAt))
    .limit(10);
  const material = annRows.map((a) => ({
    symbol: a.symbol ?? a.name,
    subject: a.subject.slice(0, 160),
    category: a.category ?? null,
    soWhat: a.soWhat ?? null,
    evidenceId: evidence(
      ev,
      `ann:${a.id}`,
      "announcement",
      `${a.symbol ?? a.name}: ${a.subject}`.slice(0, 140),
      a.url ?? null,
    ),
  }));

  return {
    asOf,
    indices: indexQuotes,
    breadth,
    sectors,
    movers: { gainers, losers },
    brokerCalls,
    signalMovers,
    announcements: material,
    evidence: ev,
  };
}
