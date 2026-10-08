import { parseIndianNumber, UpstreamError } from "@ma/core";
import { type CheerioAPI, load } from "cheerio";
import type { HttpClient } from "../http.js";

export const MONEYCONTROL_PARSER_VERSION = 1;

export type Holder = "promoter" | "fii" | "dii" | "public" | "others";
export type SwotQuadrant = "strength" | "weakness" | "opportunity" | "threat";
export type EstimateMetric = "eps" | "net_profit" | "revenue";

export interface MoneycontrolMatch {
  code: string;
  url: string;
  name: string;
}

export interface ShareholdingPoint {
  quarterEnd: string;
  holder: Holder;
  pct: number;
  pledgePct: number | null;
}

export interface MoneycontrolBrokerCard {
  publishedAt: string;
  broker: string;
  rating: string;
  recoPrice: number | null;
  targetPrice: number | null;
  reportUrl: string | null;
}

export interface SwotQuadrantFacts {
  count: number;
  items: string[];
}

export interface MoneycontrolTeasers {
  price: string[];
  financials: string[];
  industry: string[];
  shareholding: string[];
}

export interface RegisteredOffice {
  address: string | null;
  city: string | null;
  state: string | null;
  pincode: string | null;
}

export interface MoneycontrolPage {
  scId: string | null;
  stockScore: { score: number; verdict: string | null } | null;
  teasers: MoneycontrolTeasers;
  shareholding: { summary: Partial<Record<Holder, number>>; trend: ShareholdingPoint[] };
  brokerCards: MoneycontrolBrokerCard[];
  swot: Partial<Record<SwotQuadrant, SwotQuadrantFacts>>;
  swotUrl: string | null;
  registeredOffice: RegisteredOffice | null;
  management: Array<{ name: string; designation: string | null }>;
  website: string | null;
}

export interface MoneycontrolFacts {
  moneycontrolUrl: string;
  stockScore: number | null;
  verdict: string | null;
  teasers: MoneycontrolTeasers;
  swot: Partial<Record<SwotQuadrant, SwotQuadrantFacts>>;
  registeredOffice: RegisteredOffice | null;
  management: Array<{ name: string; designation: string | null }>;
  website: string | null;
}

export interface AnalystRatingSnapshot {
  buyPct: number | null;
  outperformPct: number | null;
  holdPct: number | null;
  underperformPct: number | null;
  sellPct: number | null;
  analystCount: number | null;
  finalRating: string | null;
}

export interface ConsensusMonth {
  month: string;
  buy: number | null;
  outperform: number | null;
  hold: number | null;
  underperform: number | null;
  sell: number | null;
}

export interface EarningsEstimate {
  metric: EstimateMetric;
  fiscalYearEnd: string;
  low: number | null;
  avg: number | null;
  high: number | null;
  actual: number | null;
}

export interface PriceTargetRange {
  low: number | null;
  mean: number | null;
  high: number | null;
}

export interface EarningsSurprise {
  metric: EstimateMetric;
  quarterEnd: string;
  actual: number | null;
  estimate: number | null;
  surprisePct: number | null;
  outcome: string;
}

export interface MoneycontrolEstimates {
  rating: AnalystRatingSnapshot | null;
  consensus: ConsensusMonth[];
  estimates: EarningsEstimate[];
  priceTarget: PriceTargetRange | null;
  surprises: EarningsSurprise[];
}

const HOLDERS: Record<string, Holder> = {
  Promoter: "promoter",
  FII: "fii",
  DII: "dii",
  Public: "public",
  Others: "others",
};

const TEASER_ANCHORS: Record<string, keyof MoneycontrolTeasers> = {
  "#price_volume": "price",
  "#financials": "financials",
  "#peers": "industry",
  "#sharepattern": "shareholding",
};

const SWOT_IDS: Record<string, SwotQuadrant> = {
  swot_ls: "strength",
  swot_lw: "weakness",
  swot_lo: "opportunity",
  swot_lt: "threat",
};

const QUADRANTS: SwotQuadrant[] = ["strength", "weakness", "opportunity", "threat"];

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

const ESTIMATES_BASE = "https://api.moneycontrol.com/mcapi/v1/stock/estimates";
const SURPRISE_TYPES: Array<[EstimateMetric, string]> = [
  ["eps", "eps"],
  ["net_profit", "net_profit"],
  ["revenue", "revenue"],
];

export class MoneycontrolSource {
  constructor(private readonly http: HttpClient) {}

  async resolve(symbol: string, isin: string | null): Promise<MoneycontrolMatch | null> {
    const url = `https://www.moneycontrol.com/mccode/common/autosuggestion_solr.php?classic=true&query=${encodeURIComponent(symbol)}&type=1&format=json`;
    const res = await this.http.get(url, { headers: { accept: "application/json" } });
    if (res.status === 204) return null;
    if (res.status >= 400)
      throw new UpstreamError("www.moneycontrol.com", `autosuggest status ${res.status}`, { url });
    return pickSuggestion(parseJson(res.text(), url), symbol, isin);
  }

  async estimates(scId: string): Promise<MoneycontrolEstimates> {
    const [rating, consensus, forecast, price, ...surprises] = await Promise.all([
      this.estimate(scId, "analyst-rating"),
      this.estimate(scId, "consensus"),
      this.estimate(scId, "earning-forecast", "frequency=12&financialType=C"),
      this.estimate(scId, "price-forecast"),
      ...SURPRISE_TYPES.map(([, type]) =>
        this.estimate(scId, "hits-misses", `type=${type}&financialType=C`),
      ),
    ]);
    return {
      rating: parseAnalystRating(rating),
      consensus: parseConsensus(consensus),
      estimates: parseEarningForecast(forecast),
      priceTarget: parsePriceForecast(price),
      surprises: SURPRISE_TYPES.flatMap(([metric], i) => parseHitsMisses(surprises[i], metric)),
    };
  }

  private async estimate(scId: string, endpoint: string, extra?: string): Promise<unknown> {
    const query = `${extra ? `${extra}&` : ""}scId=${encodeURIComponent(scId)}&ex=N&deviceType=W`;
    const url = `${ESTIMATES_BASE}/${endpoint}?${query}`;
    const res = await this.http.get(url, { headers: { accept: "application/json" } });
    if (res.status === 204 || res.status === 404 || res.status === 422) return null;
    if (res.status >= 400)
      throw new UpstreamError("api.moneycontrol.com", `${endpoint} status ${res.status}`, { url });
    const body = res.text().trim();
    return body ? parseJson(body, url) : null;
  }
}

export function pickSuggestion(
  data: unknown,
  symbol: string,
  isin: string | null,
): MoneycontrolMatch | null {
  if (!Array.isArray(data)) return null;
  const sym = symbol.toUpperCase();
  const wantIsin = isin?.toUpperCase() ?? null;
  const candidates = data.filter(isRecord).flatMap((e) => {
    const code = str(e.sc_id);
    const url = str(e.link_src);
    if (!code || !url?.startsWith("https://www.moneycontrol.com/")) return [];
    const span = /<span>([^<]*)<\/span>/i.exec(str(e.pdt_dis_nm) ?? "")?.[1] ?? "";
    const tokens = decodeEntities(span)
      .split(",")
      .map((t) => t.trim().toUpperCase());
    return [{ code, url, name: str(e.name) ?? str(e.stock_name) ?? "", tokens }];
  });
  const hit =
    (wantIsin ? candidates.find((c) => c.tokens.includes(wantIsin)) : undefined) ??
    candidates.find((c) => c.tokens.includes(sym));
  return hit ? { code: hit.code, url: hit.url, name: hit.name } : null;
}

export function parseMoneycontrolPage(html: string): MoneycontrolPage {
  const $ = load(html);
  const info = parseCompanyInfo($);
  return {
    scId: $("input#sc_id").attr("value")?.trim() || null,
    stockScore: parseStockScore($),
    teasers: parseTeasers($),
    shareholding: parseShareholding($),
    brokerCards: parseBrokerCards($),
    swot: parseSwotTeasers($),
    swotUrl:
      /https:\/\/www\.moneycontrol\.com\/swot-analysis\/[\w-]+\/[\w-]+\/strength/.exec(html)?.[0] ??
      null,
    ...info,
  };
}

export function trimMoneycontrolPage(html: string): string {
  const $ = load(html);
  $("svg, img, style, noscript").remove();
  const parts = [
    $("input#sc_id").first(),
    $("#mc_insight").first(),
    $("#sharepattern").first(),
    $("#broker_research").first(),
    $(".swot_feature").first(),
    $("#company_info").first(),
  ];
  for (const part of parts) {
    part.find("script").each((_, s) => {
      const text = $(s).html() ?? "";
      if (!/summary_jsn|trend_jsn/.test(text)) $(s).remove();
    });
  }
  const body = parts
    .filter((p) => p.length > 0)
    .map((p) => $.html(p))
    .join("\n");
  return `<!doctype html><html><body>\n${body}\n</body></html>`;
}

export function parseSwotPage(html: string): Partial<Record<SwotQuadrant, SwotQuadrantFacts>> {
  const $ = load(html);
  const out: Partial<Record<SwotQuadrant, SwotQuadrantFacts>> = {};
  for (const quadrant of QUADRANTS) {
    const pane = $(`#${quadrant}`).first();
    if (!pane.length) continue;
    const count = countFrom(pane.find(".swot_count").first().text());
    const items = pane
      .find("ul.swotfeatlist li")
      .map((_, li) => clean($(li).text()))
      .get()
      .filter((t) => t.length > 0);
    if (count !== null || items.length) out[quadrant] = { count: count ?? items.length, items };
  }
  return out;
}

export function trimSwotPage(html: string): string {
  const $ = load(html);
  const panes = QUADRANTS.map((q) => $(`#${q}`).first()).filter((p) => p.length > 0);
  for (const p of panes) p.find(".common_lock, svg, img, script").remove();
  return `<!doctype html><html><body>\n${panes.map((p) => $.html(p)).join("\n")}\n</body></html>`;
}

export function mergeSwot(
  page: Partial<Record<SwotQuadrant, SwotQuadrantFacts>>,
  detail: Partial<Record<SwotQuadrant, SwotQuadrantFacts>>,
): Partial<Record<SwotQuadrant, SwotQuadrantFacts>> {
  const out: Partial<Record<SwotQuadrant, SwotQuadrantFacts>> = {};
  for (const q of QUADRANTS) {
    const a = page[q];
    const b = detail[q];
    if (!a && !b) continue;
    const items = [...new Set([...(b?.items ?? []), ...(a?.items ?? [])])];
    out[q] = { count: Math.max(a?.count ?? 0, b?.count ?? 0, items.length), items };
  }
  return out;
}

export function parseAnalystRating(json: unknown): AnalystRatingSnapshot | null {
  const data = payload(json);
  if (!data || !Array.isArray(data.ratings)) return null;
  const pct = (name: string) => {
    const row = (data.ratings as unknown[])
      .filter(isRecord)
      .find((r) => str(r.name)?.toLowerCase() === name);
    return row ? num(row.value) : null;
  };
  const snapshot: AnalystRatingSnapshot = {
    buyPct: pct("buy"),
    outperformPct: pct("outperform"),
    holdPct: pct("hold"),
    underperformPct: pct("underperform"),
    sellPct: pct("sell"),
    analystCount: num(data.analystCount),
    finalRating: str(data.finalRating),
  };
  const empty =
    snapshot.analystCount === null &&
    snapshot.finalRating === null &&
    [snapshot.buyPct, snapshot.holdPct, snapshot.sellPct].every((v) => v === null);
  return empty ? null : snapshot;
}

export function parseConsensus(json: unknown): ConsensusMonth[] {
  const data = payload(json);
  if (!data || !Array.isArray(data.categories) || !Array.isArray(data.graphData)) return [];
  const series = new Map<string, unknown[]>();
  for (const s of (data.graphData as unknown[]).filter(isRecord)) {
    const name = str(s.name)?.toLowerCase();
    if (name && Array.isArray(s.data)) series.set(name, s.data);
  }
  const at = (name: string, i: number) => num(series.get(name)?.[i]);
  return (data.categories as unknown[]).flatMap((label, i) => {
    const month = monthStart(str(label) ?? "");
    if (!month) return [];
    return [
      {
        month,
        buy: at("buy", i),
        outperform: at("outperform", i),
        hold: at("hold", i),
        underperform: at("underperform", i),
        sell: at("sell", i),
      },
    ];
  });
}

export function parseEarningForecast(json: unknown): EarningsEstimate[] {
  const data = payload(json);
  if (!data) return [];
  const keys: Array<[EstimateMetric, string]> = [
    ["eps", "eps"],
    ["net_profit", "netProfit"],
    ["revenue", "revenue"],
  ];
  return keys.flatMap(([metric, key]) => {
    const rows = data[key];
    if (!Array.isArray(rows)) return [];
    return rows.filter(isRecord).flatMap((r) => {
      const fiscalYearEnd = monthEnd(str(r.date) ?? "");
      if (!fiscalYearEnd) return [];
      const row = {
        metric,
        fiscalYearEnd,
        low: num(r.low),
        avg: num(r.avg),
        high: num(r.high),
        actual: num(r.actual),
      };
      return [row.low, row.avg, row.high, row.actual].some((v) => v !== null) ? [row] : [];
    });
  });
}

export function parsePriceForecast(json: unknown): PriceTargetRange | null {
  const data = payload(json);
  if (!data) return null;
  const range = { low: num(data.low), mean: num(data.mean), high: num(data.high) };
  return range.low === null && range.mean === null && range.high === null ? null : range;
}

export function parseHitsMisses(json: unknown, metric: EstimateMetric): EarningsSurprise[] {
  const data = payload(json);
  if (!data || !Array.isArray(data.list)) return [];
  return (data.list as unknown[]).filter(isRecord).flatMap((r) => {
    const quarterEnd = monthEnd(str(r.quarter) ?? "");
    const outcome = str(r.type)?.toLowerCase();
    if (!quarterEnd || !outcome) return [];
    return [
      {
        metric,
        quarterEnd,
        actual: num(r.actual),
        estimate: num(r.estimates),
        surprisePct: num(r.surprise),
        outcome,
      },
    ];
  });
}

export function monthEnd(label: string): string | null {
  const ym = yearMonth(label);
  if (!ym) return null;
  const day = new Date(Date.UTC(ym.year, ym.month, 0)).getUTCDate();
  return `${ym.year}-${pad(ym.month)}-${pad(day)}`;
}

export function monthStart(label: string): string | null {
  const ym = yearMonth(label);
  return ym ? `${ym.year}-${pad(ym.month)}-01` : null;
}

export function parseCardDate(text: string, reportUrl: string | null): string | null {
  const m = /^(\d{1,2})\s+([A-Za-z]{3})[a-z]*,?\s+(\d{4})$/.exec(clean(text));
  if (m) {
    const month = MONTHS[(m[2] as string).toLowerCase()];
    if (month) return `${m[3]}-${pad(month)}-${pad(Number(m[1]))}`;
  }
  const fromUrl = reportUrl
    ? /\/static-mcnews\/\d{4}\/\d{2}\/(\d{4})(\d{2})(\d{2})\d*_/.exec(reportUrl)
    : null;
  if (!fromUrl) return null;
  const [, y, mo, d] = fromUrl;
  const date = new Date(`${y}-${mo}-${d}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : `${y}-${mo}-${d}`;
}

function parseStockScore($: CheerioAPI): MoneycontrolPage["stockScore"] {
  const score = num($(".insightScore").first().text());
  if (score === null) return null;
  const right = $(".insightRight").first().clone();
  right.children().remove();
  const verdict = clean(right.text());
  return { score, verdict: verdict || null };
}

function parseTeasers($: CheerioAPI): MoneycontrolTeasers {
  const out: MoneycontrolTeasers = { price: [], financials: [], industry: [], shareholding: [] };
  $(".mcinbx").each((_, box) => {
    const key = TEASER_ANCHORS[$(box).find("a.mcinhead").first().attr("href") ?? ""];
    if (!key) return;
    $(box)
      .find("ul > li")
      .each((_, li) => {
        const text = clean($(li).text());
        if (text) out[key].push(text);
      });
  });
  return out;
}

function parseShareholding($: CheerioAPI): MoneycontrolPage["shareholding"] {
  const scripts = $("script")
    .map((_, s) => $(s).html() ?? "")
    .get()
    .join("\n");
  const summaryRaw = /summary_jsn\s*=\s*'(\{[^']*\})'/.exec(scripts)?.[1];
  const trendRaw = /trend_jsn\s*=\s*'(\{[^']*\})'/.exec(scripts)?.[1];
  const summary: Partial<Record<Holder, number>> = {};
  const summaryObj = summaryRaw ? safeJson(summaryRaw) : null;
  if (isRecord(summaryObj)) {
    for (const [label, holder] of Object.entries(HOLDERS)) {
      const v = num(summaryObj[label]);
      if (v !== null) summary[holder] = v;
    }
  }
  const trend: ShareholdingPoint[] = [];
  const trendObj = trendRaw ? safeJson(trendRaw) : null;
  if (isRecord(trendObj)) {
    for (const [label, holder] of Object.entries(HOLDERS)) {
      const quarters = trendObj[label];
      if (!isRecord(quarters)) continue;
      for (const [quarter, point] of Object.entries(quarters)) {
        const quarterEnd = monthEnd(quarter);
        if (!quarterEnd || !isRecord(point)) continue;
        const pct = num(point.Holding);
        if (pct === null) continue;
        trend.push({ quarterEnd, holder, pct, pledgePct: num(point.Pledge) });
      }
    }
  }
  trend.sort(
    (a, b) => a.quarterEnd.localeCompare(b.quarterEnd) || a.holder.localeCompare(b.holder),
  );
  return { summary, trend };
}

function parseBrokerCards($: CheerioAPI): MoneycontrolBrokerCard[] {
  const cards: MoneycontrolBrokerCard[] = [];
  $("#broker_research .brrs_bx").each((_, el) => {
    const card = $(el);
    const broker = clean(card.find(".brstk_name h3").first().text());
    const rating = titleCase(clean(card.find("button[class*='button_']").first().text()));
    const href = card.find(".download_report a[href]").first().attr("href")?.trim() ?? "";
    const reportUrl = /^https?:\/\//.test(href) ? href : null;
    const publishedAt = parseCardDate(card.find(".br_date").first().text(), reportUrl);
    if (!broker || !rating || !publishedAt) return;
    const cell = (label: string) =>
      card
        .find("td")
        .filter((_, td) => clean($(td).text()).toLowerCase().startsWith(label))
        .first()
        .find("strong")
        .first()
        .text();
    cards.push({
      publishedAt,
      broker,
      rating,
      recoPrice: positive(num(cell("reco price"))),
      targetPrice: positive(num(cell("target price"))),
      reportUrl,
    });
  });
  return cards;
}

function parseSwotTeasers($: CheerioAPI): Partial<Record<SwotQuadrant, SwotQuadrantFacts>> {
  const out: Partial<Record<SwotQuadrant, SwotQuadrantFacts>> = {};
  $(".swot_feature li.swotliClass").each((_, li) => {
    const quadrant = SWOT_IDS[$(li).attr("id") ?? ""];
    if (!quadrant) return;
    const link = $(li).find("a").first();
    const count = countFrom(link.find("strong").first().text());
    const item = clean(link.find("em").first().text());
    if (count === null && !item) return;
    out[quadrant] = { count: count ?? (item ? 1 : 0), items: item ? [item] : [] };
  });
  return out;
}

function parseCompanyInfo(
  $: CheerioAPI,
): Pick<MoneycontrolPage, "registeredOffice" | "management" | "website"> {
  const empty = { registeredOffice: null, management: [], website: null };
  const raw =
    $("#company_info div[style]")
      .filter((_, d) => ($(d).attr("style") ?? "").replace(/\s/g, "").includes("display:none"))
      .map((_, d) => $(d).text().trim())
      .get()
      .find((t) => t.startsWith("{")) ?? "";
  const parsed = raw ? safeJson(raw) : null;
  const data = isRecord(parsed) && isRecord(parsed.data) ? parsed.data : null;
  if (!data) return empty;
  const addr = isRecord(data.address) ? data.address : null;
  const address = addr
    ? [str(addr.address1), str(addr.address2)]
        .filter((s): s is string => s !== null)
        .join(" ")
        .replace(/,{2,}/g, ",")
        .replace(/\s+/g, " ")
        .replace(/,\s*$/, "")
        .trim()
    : "";
  const registeredOffice = addr
    ? {
        address: address || null,
        city: str(addr.city),
        state: str(addr.state),
        pincode: str(addr.pincode),
      }
    : null;
  const management = Array.isArray(data.management)
    ? data.management.filter(isRecord).flatMap((m) => {
        const name = str(m.name);
        return name ? [{ name, designation: str(m.designation) }] : [];
      })
    : [];
  return { registeredOffice, management, website: addr ? str(addr.web) : null };
}

function payload(json: unknown): Record<string, unknown> | null {
  if (!isRecord(json)) return null;
  if (json.success !== undefined && Number(json.success) !== 1) return null;
  return isRecord(json.data) ? json.data : null;
}

function yearMonth(label: string): { year: number; month: number } | null {
  const m = /^([A-Za-z]{3})[a-z]*[\s'-]*(\d{2}|\d{4})$/.exec(clean(label));
  if (!m) return null;
  const month = MONTHS[(m[1] as string).toLowerCase()];
  if (!month) return null;
  const y = Number(m[2]);
  return { year: y < 100 ? 2000 + y : y, month };
}

function countFrom(text: string): number | null {
  const m = /\((\d+)\)/.exec(text);
  return m ? Number(m[1]) : null;
}

function parseJson(text: string, url: string): unknown {
  const parsed = safeJson(text);
  if (parsed === undefined)
    throw new UpstreamError(new URL(url).hostname, "invalid JSON response", { url });
  return parsed;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const s = String(v).trim();
  return s ? s : null;
}

function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  return parseIndianNumber(v);
}

function positive(v: number | null): number | null {
  return v !== null && v > 0 ? v : null;
}

function clean(text: string): string {
  return text
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeEntities(text: string): string {
  return text.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
}

function titleCase(text: string): string {
  return text.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
