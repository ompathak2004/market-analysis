import { parseIndianNumber } from "@ma/core";
import { type CheerioAPI, load } from "cheerio";

export const SCREENER_PARSER_VERSION = 2;

export interface ScreenerPeriod {
  periodEnd: string;
  periodType: "annual" | "quarterly";
  values: Record<string, number | null>;
}

export interface ScreenerCompany {
  name: string;
  about: string | null;
  sectorPath: string[];
  marketCapCr: number | null;
  currentPrice: number | null;
  ratios: Record<string, number | null>;
  annual: ScreenerPeriod[];
  quarterly: ScreenerPeriod[];
  annualReports: Array<{ label: string; url: string }>;
  concalls: Array<{ label: string; url: string }>;
}

const ROW_KEYS: Record<string, string> = {
  sales: "revenue",
  revenue: "revenue",
  expenses: "expenses",
  "operating profit": "operatingProfit",
  "financing profit": "operatingProfit",
  "other income": "otherIncome",
  interest: "interestExpense",
  depreciation: "depreciation",
  "profit before tax": "pretaxIncome",
  "net profit": "netIncome",
  "equity capital": "equityCapital",
  reserves: "reserves",
  borrowings: "totalDebt",
  "other liabilities": "otherLiabilities",
  "total liabilities": "totalLiabilities",
  "fixed assets": "fixedAssets",
  cwip: "cwip",
  investments: "investments",
  "other assets": "otherAssets",
  "total assets": "totalAssets",
  "cash from operating activity": "cashFromOps",
  "cash from investing activity": "cashFromInvesting",
  "cash from financing activity": "cashFromFinancing",
  "net cash flow": "netCashFlow",
  "free cash flow": "freeCashFlow",
};

export function screenerUrl(symbol: string, consolidated = true): string {
  return `https://www.screener.in/company/${encodeURIComponent(symbol)}/${consolidated ? "consolidated/" : ""}`;
}

export function parseScreenerCompany(html: string): ScreenerCompany {
  const $ = load(html);
  const name = $("h1").first().text().trim();
  const about = $(".company-profile .about p").first().text().replace(/\s+/g, " ").trim() || null;
  const sectorPath = $('#peers a[href^="/market/"], #peers p a[href^="/market/"]')
    .map((_, a) => $(a).text().trim())
    .get()
    .filter((t) => t.length > 0);

  const ratios = parseTopRatios($);
  const annual = mergeTables($, ["#profit-loss", "#balance-sheet", "#cash-flow"], "annual");
  const quarterly = mergeTables($, ["#quarters"], "quarterly");

  return {
    name,
    about,
    sectorPath,
    marketCapCr: ratios["Market Cap"] ?? null,
    currentPrice: ratios["Current Price"] ?? null,
    ratios,
    annual,
    quarterly,
    annualReports: parseLinkList($, "#documents .annual-reports ul.list-links a[href]"),
    concalls: parseConcalls($),
  };
}

function parseTopRatios($: CheerioAPI): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  $("#top-ratios li").each((_, li) => {
    const label = $(li).find(".name").text().trim();
    const value = $(li).find(".value").text().trim();
    if (!label) return;
    const nums = value.split("/").map((v) => parseIndianNumber(v.replace(/[^\d.,()-]/g, "")));
    out[label] = nums[0] ?? null;
    if (label === "High / Low" && nums.length === 2) {
      out["52w High"] = nums[0] ?? null;
      out["52w Low"] = nums[1] ?? null;
    }
  });
  return out;
}

function mergeTables(
  $: CheerioAPI,
  selectors: string[],
  periodType: "annual" | "quarterly",
): ScreenerPeriod[] {
  const byPeriod = new Map<string, Record<string, number | null>>();
  for (const sel of selectors) {
    const table = $(`${sel} table.data-table`).first();
    if (!table.length) continue;
    const headers = table
      .find("thead th")
      .map((_, th) => $(th).text().trim())
      .get()
      .slice(1);
    table.find("tbody tr").each((_, tr) => {
      const cells = $(tr).find("td");
      const rawLabel = cells
        .first()
        .text()
        .replace(/\s+/g, " ")
        .replace(/\s*\+\s*$/, "")
        .trim()
        .toLowerCase();
      const key = ROW_KEYS[rawLabel];
      if (!key) return;
      cells.slice(1).each((i, td) => {
        const header = headers[i];
        if (!header) return;
        const periodEnd = monthLabelToDate(header);
        if (!periodEnd) return;
        const row = byPeriod.get(periodEnd) ?? {};
        row[key] = parseIndianNumber($(td).text());
        byPeriod.set(periodEnd, row);
      });
    });
  }
  return [...byPeriod.entries()]
    .map(([periodEnd, values]) => ({ periodEnd, periodType, values: derive(values) }))
    .sort((a, b) => a.periodEnd.localeCompare(b.periodEnd));
}

function derive(v: Record<string, number | null>): Record<string, number | null> {
  const eq = v.equityCapital;
  const res = v.reserves;
  if (eq != null && res != null) v.totalEquity = eq + res;
  const rev = v.revenue;
  const op = v.operatingProfit;
  if (rev != null && op != null) v.cogs = rev - op;
  return v;
}

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

export function monthLabelToDate(label: string): string | null {
  const m = /^([A-Za-z]{3})\s+(\d{4})$/.exec(label.trim());
  if (!m) return null;
  const mm = MONTHS[(m[1] as string).toLowerCase()];
  if (!mm) return null;
  const year = Number(m[2]);
  const lastDay = new Date(Date.UTC(year, Number(mm), 0)).getUTCDate();
  return `${year}-${mm}-${String(lastDay).padStart(2, "0")}`;
}

function parseConcalls($: CheerioAPI): Array<{ label: string; url: string }> {
  const seen = new Set<string>();
  return $("#documents .concalls ul.list-links li")
    .map((_, li) => {
      const label = $(li).find(".nowrap").first().text().trim();
      const url = $(li).find("a[title='Raw Transcript']").attr("href") ?? "";
      return { label, url };
    })
    .get()
    .filter((l) => l.url.startsWith("http") && !seen.has(l.url) && seen.add(l.url));
}

function parseLinkList($: CheerioAPI, selector: string): Array<{ label: string; url: string }> {
  const seen = new Set<string>();
  return $(selector)
    .map((_, a) => ({ label: $(a).text().trim(), url: $(a).attr("href") ?? "" }))
    .get()
    .filter((l) => l.url.startsWith("http") && !seen.has(l.url) && seen.add(l.url));
}
