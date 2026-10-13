export type MarketIndexRole = "universe" | "benchmark";

export interface MarketIndex {
  code: string;
  name: string;
  nseName: string;
  yahooSymbol: string;
  role: MarketIndexRole;
  constituentsFile: string | null;
}

export const MARKET_INDICES = [
  {
    code: "NIFTY50",
    name: "NIFTY 50",
    nseName: "NIFTY 50",
    yahooSymbol: "^NSEI",
    role: "universe",
    constituentsFile: "ind_nifty50list.csv",
  },
  {
    code: "NIFTYNEXT50",
    name: "NIFTY Next 50",
    nseName: "NIFTY NEXT 50",
    yahooSymbol: "^NSMIDCP",
    role: "universe",
    constituentsFile: "ind_niftynext50list.csv",
  },
  {
    code: "NIFTY100",
    name: "NIFTY 100",
    nseName: "NIFTY 100",
    yahooSymbol: "^CNX100",
    role: "universe",
    constituentsFile: "ind_nifty100list.csv",
  },
  {
    code: "NIFTY200",
    name: "NIFTY 200",
    nseName: "NIFTY 200",
    yahooSymbol: "^CNX200",
    role: "universe",
    constituentsFile: "ind_nifty200list.csv",
  },
  {
    code: "NIFTY500",
    name: "NIFTY 500",
    nseName: "NIFTY 500",
    yahooSymbol: "^CRSLDX",
    role: "universe",
    constituentsFile: "ind_nifty500list.csv",
  },
  {
    code: "NIFTYBANK",
    name: "NIFTY Bank",
    nseName: "NIFTY BANK",
    yahooSymbol: "^NSEBANK",
    role: "benchmark",
    constituentsFile: null,
  },
  {
    code: "NIFTYIT",
    name: "NIFTY IT",
    nseName: "NIFTY IT",
    yahooSymbol: "^CNXIT",
    role: "benchmark",
    constituentsFile: null,
  },
] as const satisfies readonly MarketIndex[];

export type MarketIndexCode = (typeof MARKET_INDICES)[number]["code"];

export const CALENDAR_INDEX: MarketIndexCode = "NIFTY50";

export function marketIndex(code: string): MarketIndex | undefined {
  return MARKET_INDICES.find((i) => i.code === code);
}
