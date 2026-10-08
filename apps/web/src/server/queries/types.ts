import type {
  AltdataSignalInputs,
  BrokerDigest,
  BrokerThesis,
  CompanyBrief,
  Evidence,
  MarketBrief,
  RuleInsight,
  VerdictLabel,
} from "@ma/intel";

export type IsoString = string;

export interface InsightMeta {
  model: string;
  modelVersion: number;
  generatedAt: IsoString;
  inputHash: string;
  confidence: number | null;
}

export interface CompanyBriefView {
  brief: CompanyBrief;
  meta: InsightMeta;
  evidence: Evidence[];
  previous: { score: number; label: VerdictLabel; generatedAt: IsoString } | null;
}

export interface BrokerDigestView {
  digest: BrokerDigest;
  meta: InsightMeta;
}

export interface MarketBriefView {
  brief: MarketBrief;
  meta: InsightMeta;
  evidence: Evidence[];
  inputCount: number;
}

export interface FeedItem {
  symbol: string;
  name: string;
  sector: string | null;
  score: number;
  label: VerdictLabel;
  confidence: number;
  oneLiner: string;
  whatChanged: string | null;
  generatedAt: IsoString;
}

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

export interface ShareholdingQuarter {
  quarterEnd: string;
  promoter: number | null;
  fii: number | null;
  dii: number | null;
  public: number | null;
  others: number | null;
  pledge: number | null;
}

export interface CompanyResearch {
  shareholding: ShareholdingQuarter[];
  ratings: {
    asOf: string;
    buyPct: number | null;
    outperformPct: number | null;
    holdPct: number | null;
    underperformPct: number | null;
    sellPct: number | null;
    analystCount: number | null;
    finalRating: string | null;
  } | null;
  consensus: Array<{
    month: string;
    buy: number;
    outperform: number;
    hold: number;
    underperform: number;
    sell: number;
  }>;
  estimates: Array<{
    metric: string;
    fiscalYearEnd: string;
    asOf: string;
    low: number | null;
    high: number | null;
    avg: number | null;
    actual: number | null;
  }>;
  target: { asOf: string; low: number | null; mean: number | null; high: number | null } | null;
  surprises: Array<{
    metric: string;
    quarterEnd: string;
    actual: number | null;
    estimate: number | null;
    surprisePct: number | null;
    outcome: string;
  }>;
  calls: BrokerCall[];
  price: number | null;
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

export type WeeklyCount = { weekStart: string; count: number };

export interface SignalRow {
  kind: string;
  asOf: string;
  value: number | null;
  inputs: AltdataSignalInputs;
}

export interface Place {
  icao: string;
  iata: string | null;
  city: string | null;
  country: string | null;
}

export interface CompanyTravel {
  aircraft: Array<{
    registration: string;
    icaoType: string | null;
    model: string | null;
    groupName: string | null;
    linkedPerson: string | null;
    linkedRole: string | null;
    tier: string;
    confidence: number;
    privacyFlagged: boolean;
    lastSeenAt: IsoString | null;
    homeIcao: string | null;
  }>;
  legs: Array<{
    id: number;
    registration: string;
    departedAt: IsoString | null;
    arrivedAt: IsoString | null;
    durationMin: number | null;
    dep: Place | null;
    arr: Place | null;
    completeness: string;
    source: string;
  }>;
  weeklyLegCounts: WeeklyCount[];
  signals: SignalRow[];
  coverage: {
    aircraftActive: number;
    aircraftSeen30d: number;
    legsFull30d: number;
    legs30d: number;
    lastSampleAt: IsoString | null;
  };
  sources: string[];
  registryVerifiedAt: IsoString | null;
}

export interface CompanyLogistics {
  facilities: Array<{
    id: number;
    slug: string;
    name: string;
    kind: string;
    lat: number;
    lon: number;
    radiusKm: number;
    role: string;
    commodityIn: string[];
    commodityOut: string[];
    exclusive: boolean;
    verifiedAt: IsoString | null;
    coverage7d: number | null;
    arrivalsWeekly: WeeklyCount[];
    activeVessels: Array<{
      mmsi: number;
      name: string | null;
      class: string;
      sizeClass: string | null;
      sinceAt: IsoString;
      navStatus: number | null;
    }>;
  }>;
  calls: Array<{
    id: number;
    facilitySlug: string;
    mmsi: number;
    name: string | null;
    class: string;
    sizeClass: string | null;
    enteredAt: IsoString;
    leftAt: IsoString | null;
    dwellMin: number | null;
    cargoDirection: string | null;
    cargoProxy: { commodity: string | null; bbl: number | null };
  }>;
  chokepointWatch: Array<{
    mmsi: number;
    name: string | null;
    class: string;
    sizeClass: string | null;
    chokepoint: string;
    loiterMin: number;
    destination: string | null;
    destinationFacilitySlug: string | null;
    estValueCr: number | null;
    lastPositionAt: IsoString | null;
  }>;
  fleet: {
    size: number;
    seen7d: number;
    vessels: Array<{ imo: number; name: string; dwt: number | null; type: string | null }>;
  } | null;
  signals: SignalRow[];
  coverage: {
    factor7d: number | null;
    lastSampleAt: IsoString | null;
    windows24h: number;
    windowsWithData24h: number;
  };
  positionsForMap: Array<{
    mmsi: number;
    lat: number;
    lon: number;
    cogDeg: number | null;
    class: string;
    ts: IsoString;
  }>;
  sources: string[];
}

export interface AltdataActivityItem {
  id: number;
  layer: string;
  kind: string;
  occurredAt: IsoString;
  severity: number;
  headline: string;
  symbol: string | null;
  companyName: string | null;
  facilitySlug: string | null;
  detail: Record<string, unknown>;
}

export type { RuleInsight };
