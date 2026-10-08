import type { BrokerThesis } from "@ma/intel";

export type IsoString = string;

export interface FilingItem {
  id: number;
  symbol: string;
  name: string;
  publishedAt: IsoString;
  subject: string;
  category: string | null;
  materiality: string | null;
  soWhat: string | null;
  attachmentUrl: string | null;
}

export interface BrokerCall {
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
  title: string | null;
  summary: string | null;
  thesis: BrokerThesis | null;
}

export interface LatestBrokerCall extends BrokerCall {
  symbol: string;
  name: string;
  upsidePct: number | null;
}

export interface KeyStats {
  symbol: string;
  name: string;
  sector: string | null;
  industry: string | null;
  isin: string | null;
  marketCapCr: number | null;
  price: number | null;
  changePct: number | null;
  peTtm: number | null;
  pb: number | null;
  roePct: number | null;
  opmPct: number | null;
  npmPct: number | null;
  debtToEquity: number | null;
  interestCover: number | null;
  revenueGrowthPct: number | null;
  profitGrowthPct: number | null;
  revenueTtmCr: number | null;
  netIncomeTtmCr: number | null;
  latestAnnual: string | null;
  latestQuarter: string | null;
}

export interface Peer {
  symbol: string;
  name: string;
  industry: string | null;
  marketCapCr: number | null;
  close: number | null;
  changePct: number | null;
  distress: number | null;
  self: boolean;
}

export interface RangeStats {
  last: number | null;
  lastDate: string | null;
  high52: number | null;
  low52: number | null;
  fromHighPct: number | null;
  fromLowPct: number | null;
  returns: Array<{ label: string; pct: number | null }>;
  volatilityPct: number | null;
  avgVolume20: number | null;
  sma50: number | null;
  sma200: number | null;
  bars: number;
}

export interface QuoteView {
  symbol: string;
  name: string;
  sector: string | null;
  industry: string | null;
  isin: string | null;
  marketCapCr: number | null;
  price: number | null;
  change: number | null;
  changePct: number | null;
  dayLow: number | null;
  dayHigh: number | null;
  high52: number | null;
  low52: number | null;
  peTtm: number | null;
  marketState: string | null;
  asOf: IsoString | null;
  source: "live" | "close" | "none";
}

export interface CompanyCalls {
  calls: BrokerCall[];
  price: number | null;
}
