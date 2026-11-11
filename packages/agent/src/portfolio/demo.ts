export const DEMO_PORTFOLIOS_VERSION = 1;

export type Benchmark = "NIFTY50" | "NIFTYBANK" | "NIFTYIT" | "NIFTY500";

export interface CashTransaction {
  id: string;
  date: string;
  kind: "deposit" | "withdrawal";
  amount: number;
}

export interface TradeTransaction {
  id: string;
  date: string;
  kind: "buy" | "sell";
  symbol: string;
  quantity: number;
  price: number;
}

export type DemoTransaction = CashTransaction | TradeTransaction;

export function isTrade(t: DemoTransaction): t is TradeTransaction {
  return t.kind === "buy" || t.kind === "sell";
}

export interface DemoPortfolio {
  id: string;
  name: string;
  thesis: string;
  risk: "low" | "medium" | "high";
  benchmark: Benchmark;
  basisAsOf: string;
  synthetic: true;
  transactions: DemoTransaction[];
}

export const DEMO_ASSUMPTIONS = [
  "All transactions are synthetic and exist only to demonstrate analytics.",
  "Trades are filled at that session's NSE closing price on the split-adjusted basis as of basisAsOf.",
  "Brokerage, exchange charges, stamp duty and GST are excluded; STT is assumed paid on every trade.",
  "Idle cash earns nothing.",
  "The holder is a resident individual.",
] as const;

const BASIS = "2026-11-12";

const buy = (id: string, date: string, symbol: string, quantity: number, price: number) =>
  ({ id, date, kind: "buy", symbol, quantity, price }) as const;
const sell = (id: string, date: string, symbol: string, quantity: number, price: number) =>
  ({ id, date, kind: "sell", symbol, quantity, price }) as const;
const deposit = (id: string, date: string, amount: number) =>
  ({ id, date, kind: "deposit", amount }) as const;
const withdrawal = (id: string, date: string, amount: number) =>
  ({ id, date, kind: "withdrawal", amount }) as const;

export const DEMO_PORTFOLIOS: readonly DemoPortfolio[] = [
  {
    id: "core-diversified",
    name: "Diversified large caps",
    thesis:
      "Ten NIFTY 50 leaders across energy, banks, IT, FMCG, autos and pharma, built in three tranches.",
    risk: "medium",
    benchmark: "NIFTY50",
    basisAsOf: BASIS,
    synthetic: true,
    transactions: [
      deposit("d1", "2024-10-15", 1_000_000),
      buy("b1", "2024-10-15", "RELIANCE", 80, 1344.03),
      buy("b2", "2024-10-15", "HDFCBANK", 120, 842.05),
      buy("b3", "2024-10-15", "INFY", 50, 1959.3),
      buy("b4", "2024-10-15", "ITC", 200, 480.06),
      buy("b5", "2024-10-15", "LT", 25, 3551.9),
      buy("b6", "2024-10-15", "BHARTIARTL", 55, 1717.25),
      buy("b7", "2024-10-15", "SUNPHARMA", 50, 1898.45),
      buy("b8", "2024-10-15", "TITAN", 25, 3508.5),
      buy("b9", "2025-03-17", "MARUTI", 8, 11553.7),
      buy("b10", "2025-03-17", "HINDUNILVR", 40, 2171.25),
      sell("s1", "2025-09-15", "INFY", 20, 1508.4),
      buy("b11", "2026-03-16", "ICICIBANK", 60, 1272.9),
    ],
  },
  {
    id: "defence-aerospace",
    name: "Defence and aerospace",
    thesis:
      "Indigenisation theme: an early BEL position, then a basket of PSU defence, shipyards and suppliers.",
    risk: "high",
    benchmark: "NIFTY500",
    basisAsOf: BASIS,
    synthetic: true,
    transactions: [
      deposit("d1", "2024-10-15", 200_000),
      buy("b1", "2024-10-15", "BEL", 600, 288.85),
      deposit("d2", "2026-09-10", 600_000),
      buy("b2", "2026-09-10", "HAL", 30, 4950),
      buy("b3", "2026-09-10", "BDL", 100, 1195),
      buy("b4", "2026-09-10", "MAZDOCK", 50, 2383.2),
      buy("b5", "2026-09-10", "COCHINSHIP", 60, 1520.4),
      buy("b6", "2026-09-10", "DATAPATTNS", 20, 4777.2),
      buy("b7", "2026-09-10", "BHARATFORG", 25, 1954.9),
      deposit("d3", "2026-10-26", 55_000),
      buy("b8", "2026-10-26", "BEL", 150, 363),
    ],
  },
  {
    id: "banking-financials",
    name: "Banks and lenders",
    thesis:
      "Private and PSU banks with a consumer-finance tilt; one partial exit and a later NBFC add.",
    risk: "medium",
    benchmark: "NIFTYBANK",
    basisAsOf: BASIS,
    synthetic: true,
    transactions: [
      deposit("d1", "2024-10-15", 900_000),
      buy("b1", "2024-10-15", "HDFCBANK", 200, 842.05),
      buy("b2", "2024-10-15", "ICICIBANK", 120, 1255.5),
      buy("b3", "2024-10-15", "SBIN", 180, 804.65),
      buy("b4", "2024-10-15", "KOTAKBANK", 300, 379.04),
      buy("b5", "2024-10-15", "AXISBANK", 100, 1153.85),
      buy("b6", "2024-10-15", "BAJFINANCE", 150, 701.69),
      sell("s1", "2025-06-16", "AXISBANK", 40, 1215.4),
      buy("b7", "2026-09-10", "CHOLAFIN", 50, 1859),
    ],
  },
  {
    id: "it-exports",
    name: "IT services exporters",
    thesis:
      "Dollar-earning IT services, averaged down after the 2026 sell-off, plus a mid-cap add.",
    risk: "medium",
    benchmark: "NIFTYIT",
    basisAsOf: BASIS,
    synthetic: true,
    transactions: [
      deposit("d1", "2024-10-15", 700_000),
      buy("b1", "2024-10-15", "TCS", 40, 4116.8),
      buy("b2", "2024-10-15", "INFY", 80, 1959.3),
      buy("b3", "2024-10-15", "HCLTECH", 70, 1870.1),
      buy("b4", "2024-10-15", "WIPRO", 400, 266.48),
      buy("b5", "2024-10-15", "TECHM", 60, 1675.35),
      deposit("d2", "2026-03-16", 50_000),
      buy("b6", "2026-03-16", "TCS", 20, 2409.2),
      deposit("d3", "2026-09-10", 120_000),
      buy("b7", "2026-09-10", "PERSISTENT", 20, 5509.5),
    ],
  },
  {
    id: "concentrated-high-risk",
    name: "Concentrated high risk",
    thesis:
      "Half the money in one conglomerate plus turnaround and momentum names; deliberately undiversified.",
    risk: "high",
    benchmark: "NIFTY500",
    basisAsOf: BASIS,
    synthetic: true,
    transactions: [
      deposit("d1", "2026-09-10", 650_000),
      buy("b1", "2026-09-10", "ADANIENT", 100, 3077.2),
      buy("b2", "2026-09-10", "PAYTM", 60, 1739),
      buy("b3", "2026-09-10", "IDEA", 8000, 14.9),
      buy("b4", "2026-09-10", "SUZLON", 1500, 44.22),
      buy("b5", "2026-09-10", "IRFC", 500, 81.08),
      deposit("d2", "2026-10-05", 15_000),
      buy("b6", "2026-10-05", "IDEA", 2000, 12.74),
    ],
  },
  {
    id: "balanced-income",
    name: "Balanced income",
    thesis:
      "Dividend-paying staples and PSU utilities with a 30% INR cash buffer. Only listed equity and cash are modelled.",
    risk: "low",
    benchmark: "NIFTY50",
    basisAsOf: BASIS,
    synthetic: true,
    transactions: [
      deposit("d1", "2024-10-15", 1_000_000),
      buy("b1", "2024-10-15", "ITC", 300, 480.06),
      buy("b2", "2024-10-15", "HINDUNILVR", 40, 2781.45),
      buy("b3", "2024-10-15", "NTPC", 300, 426.6),
      buy("b4", "2024-10-15", "POWERGRID", 350, 329.85),
      buy("b5", "2024-10-15", "COALINDIA", 200, 494.45),
      buy("b6", "2024-10-15", "NESTLEIND", 80, 1242.12),
      withdrawal("w1", "2025-09-15", 50_000),
    ],
  },
];

export function demoPortfolio(id: string): DemoPortfolio | null {
  return DEMO_PORTFOLIOS.find((p) => p.id === id) ?? null;
}

export function portfolioSymbols(p: DemoPortfolio): string[] {
  const out = new Set<string>();
  for (const t of p.transactions) if (isTrade(t)) out.add(t.symbol);
  return [...out];
}
