export const TAX_RULES_VERSION = "2026-11-12";

export type AssetClass = "listed_equity" | "equity_fund";

export interface RateWindow {
  id: string;
  from: string;
  to: string | null;
  act: string;
  stcgSection: string;
  ltcgSection: string;
  stcgRate: number;
  ltcgRate: number;
  sources: string[];
}

export const RATE_WINDOWS: readonly RateWindow[] = [
  {
    id: "it1961-pre-2024-07-23",
    from: "2018-04-01",
    to: "2024-07-22",
    act: "Income-tax Act, 1961",
    stcgSection: "s.111A",
    ltcgSection: "s.112A",
    stcgRate: 0.15,
    ltcgRate: 0.1,
    sources: ["https://www.incometaxindia.gov.in/Tutorials/15-%20LTCG.pdf"],
  },
  {
    id: "it1961-from-2024-07-23",
    from: "2024-07-23",
    to: "2026-03-31",
    act: "Income-tax Act, 1961 as amended by Finance (No. 2) Act, 2024",
    stcgSection: "s.111A",
    ltcgSection: "s.112A",
    stcgRate: 0.2,
    ltcgRate: 0.125,
    sources: ["https://www.incometaxindia.gov.in/Tutorials/15-%20LTCG.pdf"],
  },
  {
    id: "it2025",
    from: "2026-04-01",
    to: null,
    act: "Income-tax Act, 2025 as amended by Finance Act, 2026",
    stcgSection: "s.196",
    ltcgSection: "s.198",
    stcgRate: 0.2,
    ltcgRate: 0.125,
    sources: [
      "https://www.incometaxindia.gov.in/w/section-196-78",
      "https://www.incometaxindia.gov.in/w/section-198-78",
    ],
  },
];

export const LTCG_EXEMPTION: ReadonlyArray<{ fromYearStart: string; amount: number }> = [
  { fromYearStart: "2018-04-01", amount: 100_000 },
  { fromYearStart: "2024-04-01", amount: 125_000 },
];

export const GRANDFATHER_CUTOFF = "2018-02-01";
export const CESS_RATE = 0.04;
export const SURCHARGE_CAP = 0.15;

export const TAX_ASSUMPTIONS = [
  "Resident individual; STT paid on acquisition and transfer for shares and on transfer for equity-oriented fund units.",
  "Long-term means held more than 12 months: a sale on the 12-month anniversary is short-term; the next day is the first long-term day (day-count convention is an interpretation).",
  "Rates follow the transfer date; the LTCG exemption is one aggregate amount per financial/tax year.",
  "Losses are set off within the year only: short-term losses against short-term gains first, then long-term; long-term losses only against long-term gains, all before the exemption.",
  "Other income is assumed to exceed the basic exemption limit, so no basic-exemption shortfall is absorbed and no rebate applies to these gains.",
  "Surcharge is not applied because it depends on total income; on these gains it is capped at 15%. Health and education cess of 4% is applied.",
  "Bonus shares have nil cost and are held from allotment; split shares keep the original acquisition date (interpretation).",
] as const;

export function windowFor(transferDate: string): RateWindow | null {
  return (
    RATE_WINDOWS.find((w) => transferDate >= w.from && (w.to == null || transferDate <= w.to)) ??
    null
  );
}

export function yearOf(date: string): { label: string; start: string; end: string } {
  const y = Number(date.slice(0, 4));
  const startYear = date.slice(5) >= "04-01" ? y : y - 1;
  const start = `${startYear}-04-01`;
  const end = `${startYear + 1}-03-31`;
  const span = `${startYear}-${String(startYear + 1).slice(2)}`;
  return { label: start >= "2026-04-01" ? `Tax year ${span}` : `FY ${span}`, start, end };
}

export function exemptionFor(yearStart: string): number {
  let amount = 0;
  for (const e of LTCG_EXEMPTION) if (yearStart >= e.fromYearStart) amount = e.amount;
  return amount;
}

export function longTermFrom(acquired: string): string {
  const [y, m, d] = acquired.split("-").map(Number) as [number, number, number];
  const lastDay = new Date(Date.UTC(y + 1, m, 0)).getUTCDate();
  const anniversary = new Date(Date.UTC(y + 1, m - 1, Math.min(d, lastDay)));
  anniversary.setUTCDate(anniversary.getUTCDate() + 1);
  return anniversary.toISOString().slice(0, 10);
}
