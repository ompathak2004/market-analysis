import { type DemoPortfolio, isTrade } from "./demo.js";

export interface Split {
  symbol: string;
  exDate: string;
  ratio: number;
}

export interface Dividend {
  symbol: string;
  exDate: string;
  perShare: number;
}

export interface Lot {
  symbol: string;
  lotId: string;
  acquired: string;
  quantity: number;
  costPerShare: number;
}

export interface Disposal {
  symbol: string;
  lotId: string;
  acquired: string;
  sold: string;
  quantity: number;
  costPerShare: number;
  pricePerShare: number;
}

export interface DividendCredit {
  symbol: string;
  exDate: string;
  quantity: number;
  perShare: number;
  amount: number;
}

export interface CashFlow {
  date: string;
  amount: number;
}

export interface Ledger {
  portfolioId: string;
  asOf: string;
  lots: Lot[];
  disposals: Disposal[];
  dividends: DividendCredit[];
  splits: Split[];
  cash: number;
  netDeposits: number;
  flows: CashFlow[];
}

export interface CorporateActions {
  splits: readonly Split[];
  dividends: readonly Dividend[];
}

export class LedgerError extends Error {
  constructor(
    readonly portfolioId: string,
    message: string,
  ) {
    super(`${portfolioId}: ${message}`);
  }
}

const EPS = 1e-9;

export function replay(p: DemoPortfolio, asOf: string, actions: CorporateActions): Ledger {
  const lots: Lot[] = [];
  const disposals: Disposal[] = [];
  const dividends: DividendCredit[] = [];
  const splits: Split[] = [];
  const flows: CashFlow[] = [];
  let cash = 0;
  let netDeposits = 0;

  const held = (symbol: string) =>
    lots.filter((l) => l.symbol === symbol).reduce((s, l) => s + l.quantity, 0);

  const exEvents = [
    ...actions.splits
      .filter((s) => s.exDate > p.basisAsOf && s.exDate <= asOf)
      .map((s) => ({ date: s.exDate, split: s, dividend: null })),
    ...actions.dividends
      .filter((d) => d.exDate <= asOf)
      .map((d) => ({ date: d.exDate, split: null, dividend: d })),
  ].sort((a, b) => a.date.localeCompare(b.date));

  const txns = p.transactions
    .filter((t) => t.date <= asOf)
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date));

  let e = 0;
  const applyExEvents = (until: string) => {
    while (e < exEvents.length && (exEvents[e] as (typeof exEvents)[number]).date <= until) {
      const ev = exEvents[e++] as (typeof exEvents)[number];
      if (ev.split) {
        const s = ev.split;
        if (held(s.symbol) <= EPS) continue;
        for (const l of lots) {
          if (l.symbol !== s.symbol) continue;
          l.quantity *= s.ratio;
          l.costPerShare /= s.ratio;
        }
        splits.push(s);
      } else if (ev.dividend) {
        const d = ev.dividend;
        const qty = held(d.symbol);
        if (qty <= EPS) continue;
        const amount = qty * d.perShare;
        dividends.push({
          symbol: d.symbol,
          exDate: d.exDate,
          quantity: qty,
          perShare: d.perShare,
          amount,
        });
        cash += amount;
      }
    }
  };

  for (const t of txns) {
    applyExEvents(t.date);
    if (!isTrade(t)) {
      const signed = t.kind === "deposit" ? t.amount : -t.amount;
      cash += signed;
      netDeposits += signed;
      flows.push({ date: t.date, amount: -signed });
    } else if (t.kind === "buy") {
      cash -= t.quantity * t.price;
      lots.push({
        symbol: t.symbol,
        lotId: t.id,
        acquired: t.date,
        quantity: t.quantity,
        costPerShare: t.price,
      });
    } else {
      let remaining = t.quantity;
      if (held(t.symbol) + EPS < remaining) {
        throw new LedgerError(p.id, `sell ${t.id} exceeds holding of ${t.symbol}`);
      }
      for (const l of lots) {
        if (l.symbol !== t.symbol || l.quantity <= EPS || remaining <= EPS) continue;
        const q = Math.min(l.quantity, remaining);
        disposals.push({
          symbol: t.symbol,
          lotId: l.lotId,
          acquired: l.acquired,
          sold: t.date,
          quantity: q,
          costPerShare: l.costPerShare,
          pricePerShare: t.price,
        });
        l.quantity -= q;
        remaining -= q;
      }
      cash += t.quantity * t.price;
    }
    if (cash < -0.01) throw new LedgerError(p.id, `cash negative after ${t.id}`);
  }
  applyExEvents(asOf);

  return {
    portfolioId: p.id,
    asOf,
    lots: lots.filter((l) => l.quantity > EPS),
    disposals,
    dividends,
    splits,
    cash,
    netDeposits,
    flows,
  };
}

export function splitFactorAfter(splits: readonly Split[], symbol: string, date: string): number {
  return splits
    .filter((s) => s.symbol === symbol && s.exDate > date)
    .reduce((f, s) => f * s.ratio, 1);
}
