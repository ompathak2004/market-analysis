import "server-only";

const API_URL = (process.env.API_URL ?? "http://localhost:4000").replace(/\/$/, "");
const API_KEY = process.env.API_KEY ?? "";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: ApiError };

export async function attempt<T>(p: Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, data: await p };
  } catch (e) {
    const error = e instanceof ApiError ? e : new ApiError(0, "unavailable", String(e));
    return { ok: false, error };
  }
}

export async function api<T>(path: string, revalidateSeconds = 30): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    headers: { "x-api-key": API_KEY },
    next: { revalidate: revalidateSeconds },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: { code?: string; message?: string };
    } | null;
    throw new ApiError(
      res.status,
      body?.error?.code ?? "UPSTREAM",
      body?.error?.message ?? res.statusText,
    );
  }
  return (await res.json()) as T;
}

export interface Quote {
  symbol: string;
  price: number;
  previousClose: number | null;
  change: number | null;
  changePct: number | null;
  currency: string;
  marketTime: string;
  marketState: string | null;
}

export interface Company {
  id: number;
  nseSymbol: string;
  isin: string | null;
  name: string;
  sector: string | null;
  industry: string | null;
  marketCapCr: string | null;
  yahooSymbol: string | null;
}

export interface Fundamental {
  periodEnd: string;
  periodType: "annual" | "quarterly" | "ttm";
  revenue: string | null;
  cogs: string | null;
  sga: string | null;
  rnd: string | null;
  capex: string | null;
  operatingProfit: string | null;
  interestExpense: string | null;
  pretaxIncome: string | null;
  netIncome: string | null;
  totalAssets: string | null;
  totalEquity: string | null;
  totalDebt: string | null;
  currentAssets: string | null;
  currentLiabilities: string | null;
  cashFromOps: string | null;
}

export interface Signal {
  kind: string;
  asOf: string;
  value: number;
  inputs: Record<string, unknown>;
}

export interface Overview {
  company: Company;
  quote: Quote | null;
  latestAnnual: Fundamental | null;
  latestQuarter: Fundamental | null;
  signals: Signal[];
}

export interface Bar {
  date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number;
  volume: number | null;
}

export interface AnalystCall {
  id: number;
  broker: string;
  publishedAt: string;
  action: string;
  rating: string;
  priorRating: string | null;
  targetPrice: number | null;
  priorTargetPrice: number | null;
  priceAtCall: number | null;
  reportUrl: string | null;
}

export interface AnalystView {
  calls: AnalystCall[];
  summary: {
    brokers: number;
    avgTarget: number | null;
    lowTarget: number | null;
    medianTarget: number | null;
    highTarget: number | null;
    price: number | null;
    upsidePct: number | null;
    counts: { strongBuy: number; buy: number; hold: number; sell: number };
  };
}

export interface RelationshipRow {
  id: number;
  supplierName: string;
  customerName: string;
  counterpartySymbol: string | null;
  costBucket: string;
  disclosureKind: string;
  disclosedPct: number | null;
  fiscalYear: number | null;
  validFrom: string;
  validTo: string;
  confidence: number;
  evidence: string | null;
  method: string | null;
  valueCr: string | null;
  valueLowCr: string | null;
  valueHighCr: string | null;
  supplierRevenuePct: number | null;
  customerCostPct: number | null;
}

export interface SupplyChain {
  customers: RelationshipRow[];
  suppliers: RelationshipRow[];
  signals: Signal[];
}

export interface Announcement {
  id: number;
  publishedAt: string;
  subject: string;
  details: string | null;
  attachmentUrl: string | null;
}

export interface IndexQuote {
  symbol: string;
  name: string;
  region: string;
  price: number | null;
  change: number | null;
  changePct: number | null;
  marketState: string | null;
}

export interface Mover {
  symbol: string;
  name: string;
  close: number;
  prev: number;
  changePct: number;
}

export interface LatestCall {
  symbol: string;
  name: string;
  broker: string;
  publishedAt: string;
  action: string;
  rating: string;
  priorRating: string | null;
  targetPrice: number | null;
  priorTargetPrice: number | null;
  priceAtCall: number | null;
  reportUrl: string | null;
}

export interface LeaderboardRow {
  symbol: string;
  name: string;
  sector: string | null;
  asOf: string;
  value: number;
  inputs: Record<string, unknown>;
}

export const getOverview = (symbol: string) => api<Overview>(`/v1/companies/${symbol}`, 30);
export const getPrices = (symbol: string, range: string) =>
  api<{ bars: Bar[] }>(`/v1/companies/${symbol}/prices?range=${range}`, 300);
export const getFinancials = (symbol: string) =>
  api<{ annual: Fundamental[]; quarterly: Fundamental[] }>(
    `/v1/companies/${symbol}/financials`,
    3600,
  );
export const getAnalysts = (symbol: string) =>
  api<AnalystView>(`/v1/companies/${symbol}/analysts`, 300);
export const getSupplyChain = (symbol: string) =>
  api<SupplyChain>(`/v1/companies/${symbol}/supply-chain`, 600);
export const getAnnouncements = (symbol: string) =>
  api<{ items: Announcement[] }>(`/v1/companies/${symbol}/announcements`, 300);
export const getMarketOverview = () =>
  api<{ indices: IndexQuote[]; asOf: string }>("/v1/markets/overview", 30);
export const getMovers = () =>
  api<{ gainers: Mover[]; losers: Mover[]; date: string | null }>("/v1/markets/movers", 300);
export const getLatestCalls = (limit = 25) =>
  api<{ calls: LatestCall[] }>(`/v1/analysts/latest?limit=${limit}`, 300);
export const getLeaderboard = (kind: string, limit = 10, order: "asc" | "desc" = "desc") =>
  api<{ rows: LeaderboardRow[] }>(`/v1/signals/${kind}?limit=${limit}&order=${order}`, 900);
export const search = (q: string) =>
  api<{
    results: Array<Pick<Company, "nseSymbol" | "name" | "sector" | "industry" | "marketCapCr">>;
  }>(`/v1/search?q=${encodeURIComponent(q)}`, 600);
