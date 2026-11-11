import type { DemoPortfolio } from "./demo.js";
import { type CorporateActions, type Ledger, replay, splitFactorAfter } from "./ledger.js";

export interface Quote {
  close: number;
  date: string;
}

export interface SecurityMeta {
  name: string;
  sector: string | null;
  industry: string | null;
}

export interface HoldingView {
  symbol: string;
  name: string;
  sector: string;
  industry: string | null;
  quantity: number;
  avgCost: number;
  invested: number;
  firstAcquired: string;
  price: number | null;
  priceDate: string | null;
  stale: boolean;
  value: number | null;
  unrealized: number | null;
  unrealizedPct: number | null;
  weightPct: number | null;
}

export interface Valuation {
  portfolioId: string;
  asOf: string;
  latestSession: string | null;
  holdings: HoldingView[];
  cash: number;
  invested: number;
  marketValue: number;
  totalValue: number;
  unrealized: number;
  realized: number;
  dividends: number;
  netDeposits: number;
  totalGain: number;
  missingPrices: string[];
  stalePrices: string[];
}

export const STALE_AFTER_DAYS = 4;
const UNKNOWN_SECTOR = "Unclassified";

export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

export function round(v: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

export function realizedGain(ledger: Ledger): number {
  return ledger.disposals.reduce((s, d) => s + d.quantity * (d.pricePerShare - d.costPerShare), 0);
}

export function value(
  ledger: Ledger,
  quotes: ReadonlyMap<string, Quote>,
  meta: ReadonlyMap<string, SecurityMeta>,
  latestSession: string | null,
): Valuation {
  const bySymbol = new Map<string, { qty: number; cost: number; first: string }>();
  for (const l of ledger.lots) {
    const cur = bySymbol.get(l.symbol) ?? { qty: 0, cost: 0, first: l.acquired };
    cur.qty += l.quantity;
    cur.cost += l.quantity * l.costPerShare;
    if (l.acquired < cur.first) cur.first = l.acquired;
    bySymbol.set(l.symbol, cur);
  }
  const missingPrices: string[] = [];
  const stalePrices: string[] = [];
  const holdings: HoldingView[] = [...bySymbol.entries()].map(([symbol, h]) => {
    const q = quotes.get(symbol) ?? null;
    const m = meta.get(symbol);
    const stale =
      q != null && latestSession != null && daysBetween(q.date, latestSession) > STALE_AFTER_DAYS;
    if (!q) missingPrices.push(symbol);
    if (stale) stalePrices.push(symbol);
    const v = q ? h.qty * q.close : null;
    return {
      symbol,
      name: m?.name ?? symbol,
      sector: m?.sector ?? UNKNOWN_SECTOR,
      industry: m?.industry ?? null,
      quantity: h.qty,
      avgCost: h.cost / h.qty,
      invested: h.cost,
      firstAcquired: h.first,
      price: q?.close ?? null,
      priceDate: q?.date ?? null,
      stale,
      value: v,
      unrealized: v == null ? null : v - h.cost,
      unrealizedPct: v == null || h.cost === 0 ? null : ((v - h.cost) / h.cost) * 100,
      weightPct: null,
    };
  });
  const marketValue = holdings.reduce((s, h) => s + (h.value ?? 0), 0);
  const totalValue = marketValue + ledger.cash;
  for (const h of holdings)
    h.weightPct = h.value == null || totalValue <= 0 ? null : (h.value / totalValue) * 100;
  holdings.sort((a, b) => (b.value ?? -1) - (a.value ?? -1));
  const unrealized = holdings.reduce((s, h) => s + (h.unrealized ?? 0), 0);
  const realized = realizedGain(ledger);
  const dividends = ledger.dividends.reduce((s, d) => s + d.amount, 0);
  return {
    portfolioId: ledger.portfolioId,
    asOf: ledger.asOf,
    latestSession,
    holdings,
    cash: ledger.cash,
    invested: holdings.reduce((s, h) => s + h.invested, 0),
    marketValue,
    totalValue,
    unrealized,
    realized,
    dividends,
    netDeposits: ledger.netDeposits,
    totalGain: totalValue - ledger.netDeposits,
    missingPrices,
    stalePrices,
  };
}

export interface Allocation {
  key: string;
  value: number;
  weightPct: number;
  symbols: string[];
}

export function allocation(v: Valuation, by: "sector" | "industry" | "symbol"): Allocation[] {
  const groups = new Map<string, Allocation>();
  for (const h of v.holdings) {
    if (h.value == null) continue;
    const key =
      by === "symbol" ? h.symbol : by === "sector" ? h.sector : (h.industry ?? UNKNOWN_SECTOR);
    const g = groups.get(key) ?? { key, value: 0, weightPct: 0, symbols: [] };
    g.value += h.value;
    g.symbols.push(h.symbol);
    groups.set(key, g);
  }
  if (v.cash > 0.5) groups.set("Cash", { key: "Cash", value: v.cash, weightPct: 0, symbols: [] });
  const out = [...groups.values()];
  for (const g of out) g.weightPct = v.totalValue > 0 ? (g.value / v.totalValue) * 100 : 0;
  return out.sort((a, b) => b.value - a.value);
}

export interface Concentration {
  hhi: number;
  effectiveHoldings: number;
  top1Pct: number;
  top3Pct: number;
  top5Pct: number;
  largestSector: { sector: string; weightPct: number } | null;
  basis: "equity_market_value";
}

export function concentration(v: Valuation): Concentration | null {
  const priced = v.holdings.filter((h) => h.value != null && h.value > 0);
  if (!priced.length || v.marketValue <= 0) return null;
  const w = priced.map((h) => (h.value as number) / v.marketValue).sort((a, b) => b - a);
  const hhi = w.reduce((s, x) => s + x * x, 0);
  const top = (n: number) => w.slice(0, n).reduce((s, x) => s + x, 0) * 100;
  const sectors = allocation(v, "sector").filter((a) => a.key !== "Cash");
  const largest = sectors[0];
  return {
    hhi,
    effectiveHoldings: 1 / hhi,
    top1Pct: top(1),
    top3Pct: top(3),
    top5Pct: top(5),
    largestSector: largest
      ? { sector: largest.key, weightPct: (largest.value / v.marketValue) * 100 }
      : null,
    basis: "equity_market_value",
  };
}

export function xirr(flows: ReadonlyArray<{ date: string; amount: number }>): number | null {
  if (flows.length < 2) return null;
  if (!flows.some((f) => f.amount > 0) || !flows.some((f) => f.amount < 0)) return null;
  const t0 = flows[0]?.date as string;
  const years = flows.map((f) => daysBetween(t0, f.date) / 365);
  if ((years.at(-1) ?? 0) < 1 / 365) return null;
  const npv = (r: number) =>
    flows.reduce((s, f, i) => s + f.amount / (1 + r) ** (years[i] as number), 0);
  let lo = -0.9999;
  let hi = 100;
  let fLo = npv(lo);
  if (fLo * npv(hi) > 0) return null;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const fMid = npv(mid);
    if (Math.abs(fMid) < 1e-7) return mid;
    if (fLo * fMid < 0) hi = mid;
    else {
      lo = mid;
      fLo = fMid;
    }
  }
  return (lo + hi) / 2;
}

export interface SeriesPoint {
  date: string;
  value: number;
  flow: number;
  index: number;
}

export interface ValueSeries {
  points: SeriesPoint[];
  start: string | null;
  forwardFilled: number;
  limitedBy: string[];
}

export function valueSeries(
  p: DemoPortfolio,
  actions: CorporateActions,
  closes: ReadonlyMap<string, ReadonlyArray<Quote>>,
  asOf: string,
): ValueSeries {
  const first = p.transactions.reduce((m, t) => (t.date < m ? t.date : m), asOf);
  const dates = new Set<string>();
  for (const series of closes.values())
    for (const q of series) if (q.date >= first && q.date <= asOf) dates.add(q.date);
  const sorted = [...dates].sort();
  const splits = actions.splits.filter((s) => s.exDate > p.basisAsOf);
  const cursor = new Map<string, number>();
  const points: SeriesPoint[] = [];
  const limitedBy = new Set<string>();
  let forwardFilled = 0;
  for (const d of sorted) {
    const ledger = replay(p, d, actions);
    let total = ledger.cash;
    let valid = true;
    for (const l of ledger.lots) {
      const series = closes.get(l.symbol) ?? [];
      let i = cursor.get(l.symbol) ?? -1;
      while (i + 1 < series.length && (series[i + 1] as Quote).date <= d) i++;
      cursor.set(l.symbol, i);
      const q = series[i];
      if (!q) {
        valid = false;
        limitedBy.add(l.symbol);
        break;
      }
      if (q.date !== d) forwardFilled++;
      total += l.quantity * splitFactorAfter(splits, l.symbol, d) * q.close;
    }
    const flow = -ledger.flows.filter((f) => f.date === d).reduce((s, f) => s + f.amount, 0);
    if (!valid) {
      points.length = 0;
      forwardFilled = 0;
      continue;
    }
    const prev = points.at(-1);
    const index = prev && prev.value > 0 ? prev.index * ((total - flow) / prev.value) : 100;
    points.push({ date: d, value: total, flow, index });
  }
  return { points, start: points[0]?.date ?? null, forwardFilled, limitedBy: [...limitedBy] };
}

export interface Drawdown {
  maxDrawdownPct: number;
  peakDate: string;
  troughDate: string;
  currentDrawdownPct: number;
}

export function drawdown(points: ReadonlyArray<{ date: string; index: number }>): Drawdown | null {
  if (points.length < 2) return null;
  let peak = points[0] as { date: string; index: number };
  let best = { dd: 0, peak: peak.date, trough: peak.date };
  for (const pt of points) {
    if (pt.index > peak.index) peak = pt;
    const dd = (pt.index / peak.index - 1) * 100;
    if (dd < best.dd) best = { dd, peak: peak.date, trough: pt.date };
  }
  const last = points.at(-1) as { index: number };
  return {
    maxDrawdownPct: best.dd,
    peakDate: best.peak,
    troughDate: best.trough,
    currentDrawdownPct: (last.index / peak.index - 1) * 100,
  };
}

export interface BenchmarkComparison {
  benchmark: string;
  from: string;
  to: string;
  sessions: number;
  portfolioReturnPct: number;
  benchmarkReturnPct: number;
  excessPct: number;
  series: Array<{ date: string; portfolio: number; benchmark: number }>;
}

export function compareToBenchmark(
  points: readonly SeriesPoint[],
  benchmark: string,
  levels: ReadonlyArray<Quote>,
): BenchmarkComparison | null {
  const byDate = new Map(levels.map((l) => [l.date, l.close]));
  const common = points.filter((p) => byDate.has(p.date));
  if (common.length < 2) return null;
  const p0 = common[0] as SeriesPoint;
  const b0 = byDate.get(p0.date) as number;
  const series = common.map((p) => ({
    date: p.date,
    portfolio: (p.index / p0.index) * 100,
    benchmark: ((byDate.get(p.date) as number) / b0) * 100,
  }));
  const last = series.at(-1) as { portfolio: number; benchmark: number; date: string };
  return {
    benchmark,
    from: p0.date,
    to: last.date,
    sessions: common.length,
    portfolioReturnPct: last.portfolio - 100,
    benchmarkReturnPct: last.benchmark - 100,
    excessPct: last.portfolio - last.benchmark,
    series,
  };
}

export interface Contribution {
  symbol: string;
  fromPrice: number | null;
  toPrice: number | null;
  quantity: number;
  changePct: number | null;
  contribution: number | null;
}

export interface Movement {
  from: string;
  to: string;
  startValue: number;
  endValue: number;
  netFlows: number;
  pnl: number;
  returnPct: number;
  tradedInWindow: boolean;
  contributions: Contribution[];
}

export function movement(
  p: DemoPortfolio,
  actions: CorporateActions,
  series: ValueSeries,
  closes: ReadonlyMap<string, ReadonlyArray<Quote>>,
  sessions: number,
): Movement | null {
  const pts = series.points;
  if (pts.length < 2) return null;
  const end = pts.at(-1) as SeriesPoint;
  const start = pts[Math.max(0, pts.length - 1 - sessions)] as SeriesPoint;
  const window = pts.filter((x) => x.date > start.date && x.date <= end.date);
  const netFlows = window.reduce((s, x) => s + x.flow, 0);
  const ledger = replay(p, end.date, actions);
  const qty = new Map<string, number>();
  for (const l of ledger.lots) qty.set(l.symbol, (qty.get(l.symbol) ?? 0) + l.quantity);
  const at = (symbol: string, d: string) => {
    const s = closes.get(symbol) ?? [];
    let found: Quote | null = null;
    for (const q of s) if (q.date <= d) found = q;
    return found?.close ?? null;
  };
  const contributions = [...qty.entries()]
    .map(([symbol, quantity]) => {
      const fromPrice = at(symbol, start.date);
      const toPrice = at(symbol, end.date);
      return {
        symbol,
        fromPrice,
        toPrice,
        quantity,
        changePct: fromPrice && toPrice ? (toPrice / fromPrice - 1) * 100 : null,
        contribution:
          fromPrice != null && toPrice != null ? quantity * (toPrice - fromPrice) : null,
      };
    })
    .sort((a, b) => (a.contribution ?? 0) - (b.contribution ?? 0));
  return {
    from: start.date,
    to: end.date,
    startValue: start.value,
    endValue: end.value,
    netFlows,
    pnl: end.value - start.value - netFlows,
    returnPct: (end.index / start.index - 1) * 100,
    tradedInWindow: p.transactions.some((t) => t.date > start.date && t.date <= end.date),
    contributions,
  };
}

export interface Shock {
  target: { kind: "symbol" | "sector" | "all"; value: string | null };
  pct: number;
}

export interface ScenarioResult {
  shocks: Shock[];
  before: number;
  after: number;
  change: number;
  changePct: number;
  holdings: Array<{
    symbol: string;
    sector: string;
    before: number;
    after: number;
    shockPct: number;
  }>;
  unpriced: string[];
}

export function scenario(v: Valuation, shocks: readonly Shock[]): ScenarioResult {
  const pick = (h: HoldingView) =>
    shocks.find((s) => s.target.kind === "symbol" && s.target.value?.toUpperCase() === h.symbol) ??
    shocks.find(
      (s) => s.target.kind === "sector" && s.target.value?.toLowerCase() === h.sector.toLowerCase(),
    ) ??
    shocks.find((s) => s.target.kind === "all");
  const holdings = v.holdings
    .filter((h) => h.value != null)
    .map((h) => {
      const pct = pick(h)?.pct ?? 0;
      const before = h.value as number;
      return {
        symbol: h.symbol,
        sector: h.sector,
        before,
        after: before * (1 + pct / 100),
        shockPct: pct,
      };
    });
  const after = holdings.reduce((s, h) => s + h.after, 0) + v.cash;
  return {
    shocks: [...shocks],
    before: v.totalValue,
    after,
    change: after - v.totalValue,
    changePct: v.totalValue > 0 ? ((after - v.totalValue) / v.totalValue) * 100 : 0,
    holdings,
    unpriced: v.missingPrices,
  };
}
