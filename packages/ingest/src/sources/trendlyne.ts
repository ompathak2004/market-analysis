import { parseIndianNumber } from "@ma/core";
import { load } from "cheerio";

export const TRENDLYNE_PARSER_VERSION = 2;

export interface BrokerCall {
  nseSymbol: string | null;
  companyName: string;
  broker: string;
  publishedAt: string;
  rating: string;
  targetPrice: number | null;
  priceAtCall: number | null;
  upsidePct: number | null;
  reportUrl: string | null;
}

export const trendlyneAllReportsUrl = (page = 1): string =>
  page === 1
    ? "https://trendlyne.com/research-reports/all/"
    : `https://trendlyne.com/research-reports/all/?page=${page}`;

export const trendlyneStockReportsUrl = (trendlyneId: number, symbol: string): string =>
  `https://trendlyne.com/research-reports/stock/${trendlyneId}/${symbol}/`;

const MONTHS: Record<string, string> = {
  jan: "01",
  feb: "02",
  mar: "03",
  apr: "04",
  may: "05",
  jun: "06",
  jul: "07",
  aug: "08",
  sep: "09",
  oct: "10",
  nov: "11",
  dec: "12",
};

export function parseTrendlyneReports(html: string): BrokerCall[] {
  const $ = load(html);
  const calls: BrokerCall[] = [];
  $("table tbody tr").each((_, tr) => {
    const tds = $(tr).find("td");
    if (tds.length < 9) return;
    const date = toIsoDate($(tds[1]).attr("data-sort") ?? $(tds[1]).text());
    const stockLink = $(tds[2]).find("a[href*='/research-reports/stock/']").first();
    const stockHref = stockLink.attr("href") ?? "";
    const symbol = /\/research-reports\/stock\/\d+\/([A-Z0-9&-]+)\//.exec(stockHref)?.[1] ?? null;
    const companyName = stockLink.text().trim();
    const broker = $(tds[3]).find("a").first().text().trim() || $(tds[3]).text().trim();
    const rating = $(tds[8]).text().trim();
    const postHref =
      $(tds[9]).find("a[href*='/posts/']").attr("href") ??
      $(tr).find("a.newslink").attr("href") ??
      null;
    if (!date || !companyName || !broker) return;
    calls.push({
      nseSymbol: symbol,
      companyName,
      broker,
      publishedAt: date,
      rating: rating || "Not Rated",
      targetPrice: parseIndianNumber($(tds[5]).text()),
      priceAtCall: parseIndianNumber($(tds[6]).text().trim().split(/\s+/)[0] ?? ""),
      upsidePct: parseIndianNumber($(tds[7]).text()),
      reportUrl: postHref ? new URL(postHref, "https://trendlyne.com").href : null,
    });
  });
  return calls;
}

function toIsoDate(text: string): string | null {
  const m = /(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})/.exec(text);
  if (!m) return null;
  const mm = MONTHS[(m[2] as string).toLowerCase()];
  return mm ? `${m[3]}-${mm}-${(m[1] as string).padStart(2, "0")}` : null;
}
