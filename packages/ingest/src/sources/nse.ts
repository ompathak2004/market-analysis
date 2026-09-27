import type { HttpClient } from "../http.js";

export interface IndexMember {
  name: string;
  industry: string;
  symbol: string;
  isin: string;
}

export interface NseAnnouncement {
  symbol: string;
  companyName: string;
  subject: string;
  details: string;
  attachmentUrl: string | null;
  publishedAt: Date;
  industry: string | null;
  isin: string | null;
}

export const NSE_INDEX_FILES: Record<string, string> = {
  NIFTY50: "ind_nifty50list.csv",
  NIFTYNEXT50: "ind_niftynext50list.csv",
  NIFTY100: "ind_nifty100list.csv",
  NIFTY200: "ind_nifty200list.csv",
  NIFTY500: "ind_nifty500list.csv",
};

export function parseIndexCsv(csv: string): IndexMember[] {
  const lines = csv.trim().split(/\r?\n/);
  const header = (lines[0] ?? "").split(",").map((h) => h.trim().toLowerCase());
  const col = (name: string) => header.findIndex((h) => h.startsWith(name));
  const iName = col("company name");
  const iInd = col("industry");
  const iSym = col("symbol");
  const iIsin = col("isin");
  return lines.slice(1).flatMap((line) => {
    const cells = splitCsvLine(line);
    const symbol = cells[iSym]?.trim();
    if (!symbol) return [];
    return [
      {
        name: cells[iName]?.trim() ?? symbol,
        industry: cells[iInd]?.trim() ?? "",
        symbol,
        isin: cells[iIsin]?.trim() ?? "",
      },
    ];
  });
}

interface RawAnnouncement {
  symbol: string;
  sm_name: string;
  desc: string;
  attchmntText: string;
  attchmntFile: string | null;
  an_dt: string;
  smIndustry: string | null;
  sm_isin: string | null;
}

export function parseAnnouncements(json: string): NseAnnouncement[] {
  const rows = JSON.parse(json) as RawAnnouncement[];
  return rows.map((r) => ({
    symbol: r.symbol,
    companyName: r.sm_name,
    subject: r.desc,
    details: r.attchmntText,
    attachmentUrl: r.attchmntFile || null,
    publishedAt: parseNseDate(r.an_dt),
    industry: r.smIndustry || null,
    isin: r.sm_isin || null,
  }));
}

const MONTHS: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

export function parseNseDate(s: string): Date {
  const m = /^(\d{2})-([A-Za-z]{3})-(\d{4})(?: (\d{2}):(\d{2}):(\d{2}))?$/.exec(s.trim());
  if (!m) return new Date(s);
  const [, dd, mon, yyyy, hh = "0", mi = "0", ss = "0"] = m;
  const month = MONTHS[(mon as string).toLowerCase()] ?? 0;
  return new Date(
    Date.UTC(Number(yyyy), month, Number(dd), Number(hh) - 5, Number(mi) - 30, Number(ss)),
  );
}

export class NseSource {
  constructor(
    private readonly http: HttpClient,
    private readonly baseUrl: string,
  ) {}

  async indexMembers(code: keyof typeof NSE_INDEX_FILES | string): Promise<IndexMember[]> {
    const file = NSE_INDEX_FILES[code];
    if (!file) throw new Error(`Unknown NSE index ${code}`);
    const res = await this.http.get(`https://nsearchives.nseindia.com/content/indices/${file}`);
    return parseIndexCsv(res.text());
  }

  async announcements(symbol: string): Promise<NseAnnouncement[]> {
    const res = await this.http.get(
      `${this.baseUrl}/api/corporate-announcements?index=equities&symbol=${encodeURIComponent(symbol)}`,
      {
        headers: {
          accept: "application/json, text/plain, */*",
          referer: `${this.baseUrl}/companies-listing/corporate-filings-announcements`,
        },
      },
    );
    return parseAnnouncements(res.text());
  }
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (ch === "," && !quoted) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}
