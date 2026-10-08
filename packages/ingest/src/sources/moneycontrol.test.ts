import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  mergeSwot,
  monthEnd,
  monthStart,
  parseAnalystRating,
  parseCardDate,
  parseConsensus,
  parseEarningForecast,
  parseHitsMisses,
  parseMoneycontrolPage,
  parsePriceForecast,
  parseSwotPage,
  pickSuggestion,
  trimMoneycontrolPage,
  trimSwotPage,
} from "./moneycontrol.js";

const fixture = (name: string) =>
  readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8");

const stockPage = fixture("moneycontrol-ri.html.txt");
const swotPage = fixture("moneycontrol-swot.html.txt");

const suggestions = [
  {
    link_src: "https://www.moneycontrol.com/india/stockpricequote/refineries/relianceindustries/RI",
    pdt_dis_nm: "Reliance Industries&nbsp;<span>INE002A01018, RELIANCE, 500325</span>",
    name: "Reliance Industries",
    sc_id: "RI",
  },
  {
    link_src:
      "https://www.moneycontrol.com/india/stockpricequote/power-generationdistribution/relianceinfrastructure/RI38",
    pdt_dis_nm: "Reliance Infrastructure&nbsp;<span>INE036A01016, RELINFRA, 500390</span>",
    name: "Reliance Infrastructure",
    sc_id: "BSE",
  },
  {
    link_src:
      "https://www.moneycontrol.com/india/stockpricequote/auto-carsjeeps/mahindramahindra/MM",
    pdt_dis_nm: "Mahindra &amp; Mahindra&nbsp;<span>INE101A01026, M&amp;M, 500520</span>",
    name: "Mahindra & Mahindra",
    sc_id: "MM",
  },
];

describe("pickSuggestion", () => {
  it("matches on ISIN before symbol", () => {
    expect(pickSuggestion(suggestions, "WRONG", "INE002A01018")).toEqual({
      code: "RI",
      url: "https://www.moneycontrol.com/india/stockpricequote/refineries/relianceindustries/RI",
      name: "Reliance Industries",
    });
  });

  it("keeps sc_id even when it differs from the URL tail", () => {
    const hit = pickSuggestion(suggestions, "RELINFRA", null);
    expect(hit?.code).toBe("BSE");
    expect(hit?.url.endsWith("/RI38")).toBe(true);
  });

  it("decodes entities in the NSE symbol token", () => {
    expect(pickSuggestion(suggestions, "M&M", null)?.code).toBe("MM");
  });

  it("never guesses by name", () => {
    expect(pickSuggestion(suggestions, "RELIANCEP1", "INE000000000")).toBeNull();
    expect(pickSuggestion(suggestions, "Reliance Industries", null)).toBeNull();
    expect(pickSuggestion({ error: "x" }, "RELIANCE", null)).toBeNull();
  });

  it("ignores suggestions that do not link to moneycontrol", () => {
    const off = [{ ...suggestions[0], link_src: "https://example.com/RI" }];
    expect(pickSuggestion(off, "RELIANCE", null)).toBeNull();
  });
});

describe("parseMoneycontrolPage", () => {
  const page = parseMoneycontrolPage(stockPage);

  it("reads the scId and stock score", () => {
    expect(page.scId).toBe("RI");
    expect(page.stockScore).toEqual({
      score: 68,
      verdict: "Superior Financial Strength, Average Growth Trend Stock Priced at High Valuations",
    });
  });

  it("keys insight teasers by their anchor", () => {
    expect(page.teasers).toEqual({
      price: ["26.91% away from 52 week high"],
      financials: [],
      industry: ["Market Cap - Market Leader"],
      shareholding: ["Promoters increased holding from 49.11% to 49.62% in Jun 2026 qtr."],
    });
  });

  it("parses shareholding summary and quarterly trend", () => {
    expect(page.shareholding.summary).toEqual({
      promoter: 49.62,
      fii: 16.9,
      dii: 20.92,
      public: 8.43,
      others: 4.12,
    });
    expect(page.shareholding.trend).toEqual([
      { quarterEnd: "2026-03-31", holder: "dii", pct: 20.28, pledgePct: null },
      { quarterEnd: "2026-03-31", holder: "fii", pct: 18.33, pledgePct: null },
      { quarterEnd: "2026-03-31", holder: "promoter", pct: 49.11, pledgePct: 0 },
      { quarterEnd: "2026-06-30", holder: "dii", pct: 20.92, pledgePct: null },
      { quarterEnd: "2026-06-30", holder: "fii", pct: 16.9, pledgePct: null },
      { quarterEnd: "2026-06-30", holder: "promoter", pct: 49.62, pledgePct: 0 },
    ]);
  });

  it("parses broker cards, falling back to the PDF date and dropping undated cards", () => {
    expect(page.brokerCards).toEqual([
      {
        publishedAt: "2026-03-12",
        broker: "Motilal Oswal",
        rating: "Buy",
        recoPrice: 1391.85,
        targetPrice: 1750,
        reportUrl:
          "https://images.moneycontrol.com/static-mcnews/2026/03/20260313040346_Reliance-Industries-1303026-moti.pdf",
      },
      {
        publishedAt: "2025-11-20",
        broker: "Motilal Oswal",
        rating: "Buy",
        recoPrice: null,
        targetPrice: 1765,
        reportUrl:
          "https://images.moneycontrol.com/static-mcnews/2025/11/20251120063554_Reliance-Industries-20112025-moti.pdf",
      },
      {
        publishedAt: "2025-08-29",
        broker: "Prabhudas Lilladher",
        rating: "Hold",
        recoPrice: 1357.2,
        targetPrice: null,
        reportUrl: null,
      },
    ]);
  });

  it("reads SWOT teasers and the detail URL", () => {
    expect(page.swot).toEqual({
      strength: { count: 13, items: ["High Growth Stock with Promoters increasing shareholding"] },
      weakness: { count: 4, items: ["FII/FPI decreased their shareholding last quarter"] },
      opportunity: {
        count: 1,
        items: [
          "Companies with Price to Earnings (PE) less than average 3 Year PE, 5 Year PE and 10 Year PE",
        ],
      },
      threat: { count: 4, items: ["Below 200 DMA"] },
    });
    expect(page.swotUrl).toBe(
      "https://www.moneycontrol.com/swot-analysis/relianceindustries/RI/strength",
    );
  });

  it("reads registered office and management from the hidden company JSON", () => {
    expect(page.registeredOffice).toEqual({
      address: "3rd Floor, Maker Chambers IV,222, Nariman Point",
      city: "Mumbai",
      state: "Maharashtra",
      pincode: "400021",
    });
    expect(page.website).toBe("http://www.ril.com");
    expect(page.management).toEqual([
      { name: "Mukesh D Ambani", designation: "Chairman & Managing Director" },
      { name: "Nikhil R Meswani", designation: null },
    ]);
  });

  it("returns empty sections for an unrelated page", () => {
    expect(parseMoneycontrolPage("<html><body><p>Not found</p></body></html>")).toEqual({
      scId: null,
      stockScore: null,
      teasers: { price: [], financials: [], industry: [], shareholding: [] },
      shareholding: { summary: {}, trend: [] },
      brokerCards: [],
      swot: {},
      swotUrl: null,
      registeredOffice: null,
      management: [],
      website: null,
    });
  });
});

describe("trimMoneycontrolPage", () => {
  it("parses identically after trimming", () => {
    const wrapped = `<html><head><style>.x{}</style><script>var ads = 1;</script></head><body><header><img src="a.png"></header>${stockPage}<footer><script>track();</script></footer></body></html>`;
    const trimmed = trimMoneycontrolPage(wrapped);
    expect(trimmed).not.toContain("track()");
    expect(trimmed).not.toContain("var ads");
    expect(trimmed).toContain("trend_jsn");
    expect(parseMoneycontrolPage(trimmed)).toEqual(parseMoneycontrolPage(stockPage));
  });
});

describe("SWOT detail page", () => {
  const detail = parseSwotPage(swotPage);

  it("reads counts and visible items per quadrant", () => {
    expect(detail.strength).toEqual({
      count: 13,
      items: [
        "High Growth Stock with Promoters increasing shareholding",
        "Promoter Increasing Holding",
      ],
    });
    expect(detail.threat).toEqual({ count: 4, items: ["Below 200 DMA", "Below 20 DMA"] });
  });

  it("keeps only the quadrant panes when trimming", () => {
    const trimmed = trimSwotPage(swotPage);
    expect(trimmed).not.toContain("Footer");
    expect(trimmed).not.toContain("common_lock");
    expect(trimmed).not.toContain("trackSwot");
    expect(parseSwotPage(trimmed)).toEqual(detail);
  });

  it("merges detail items ahead of page teasers without duplicates", () => {
    const merged = mergeSwot(parseMoneycontrolPage(stockPage).swot, detail);
    expect(merged.strength).toEqual(detail.strength);
    expect(merged.opportunity?.items).toHaveLength(1);
    expect(mergeSwot({}, {})).toEqual({});
  });
});

describe("estimates parsers", () => {
  it("parses analyst rating percentages", () => {
    const json = {
      success: 1,
      data: {
        ratings: [
          { name: "Buy", value: "76" },
          { name: "Outperform", value: "20" },
          { name: "Hold", value: "0" },
          { name: "Underperform", value: "4" },
          { name: "Sell", value: "0" },
        ],
        finalRating: "Buy",
        analystCount: "25",
      },
    };
    expect(parseAnalystRating(json)).toEqual({
      buyPct: 76,
      outperformPct: 20,
      holdPct: 0,
      underperformPct: 4,
      sellPct: 0,
      analystCount: 25,
      finalRating: "Buy",
    });
    expect(parseAnalystRating({ success: 1, data: { ratings: [] } })).toBeNull();
  });

  it("parses consensus history into month starts", () => {
    const json = {
      success: 1,
      data: {
        graphData: [
          { name: "Buy", data: [25, 19] },
          { name: "Outperform", data: [5, 5] },
          { name: "Hold", data: [0, 0] },
          { name: "Underperform", data: [1, 1] },
          { name: "Sell", data: [0, 0] },
        ],
        categories: ["Jun 2026", "Oct 2026"],
      },
    };
    expect(parseConsensus(json)).toEqual([
      { month: "2026-06-01", buy: 25, outperform: 5, hold: 0, underperform: 1, sell: 0 },
      { month: "2026-10-01", buy: 19, outperform: 5, hold: 0, underperform: 1, sell: 0 },
    ]);
  });

  it("parses earnings forecasts per metric and fiscal year end", () => {
    const json = {
      success: 1,
      data: {
        eps: [
          { date: "Mar 2027", high: "76", low: "54", avg: "64", actual: "" },
          { date: "Mar 2026", high: "66", low: "53", avg: "59", actual: "60" },
          { date: "Mar 2025", high: "", low: "", avg: "", actual: "" },
        ],
        netProfit: [{ date: "Mar 2027", high: "1,03,385", low: "72446", avg: "86074", actual: "" }],
        revenue: [],
      },
    };
    expect(parseEarningForecast(json)).toEqual([
      { metric: "eps", fiscalYearEnd: "2027-03-31", low: 54, avg: 64, high: 76, actual: null },
      { metric: "eps", fiscalYearEnd: "2026-03-31", low: 53, avg: 59, high: 66, actual: 60 },
      {
        metric: "net_profit",
        fiscalYearEnd: "2027-03-31",
        low: 72446,
        avg: 86074,
        high: 103385,
        actual: null,
      },
    ]);
  });

  it("parses the price target range", () => {
    const json = { success: 1, data: { graphData: [], high: "1890", mean: "1675", low: "1350" } };
    expect(parsePriceForecast(json)).toEqual({ low: 1350, mean: 1675, high: 1890 });
    expect(parsePriceForecast({ success: 1, data: { high: "", mean: "", low: "" } })).toBeNull();
  });

  it("parses hits and misses with blank free-tier estimates", () => {
    const json = {
      success: 1,
      data: {
        list: [
          { quarter: "Jun 2026", actual: "309,468", estimates: "", surprise: "", type: "positive" },
          {
            quarter: "Mar 2026",
            actual: "294059",
            estimates: "290000",
            surprise: "1.4",
            type: "Inline",
          },
          { quarter: "", actual: "1", estimates: "", surprise: "", type: "negative" },
        ],
      },
    };
    expect(parseHitsMisses(json, "revenue")).toEqual([
      {
        metric: "revenue",
        quarterEnd: "2026-06-30",
        actual: 309468,
        estimate: null,
        surprisePct: null,
        outcome: "positive",
      },
      {
        metric: "revenue",
        quarterEnd: "2026-03-31",
        actual: 294059,
        estimate: 290000,
        surprisePct: 1.4,
        outcome: "inline",
      },
    ]);
  });

  it("treats empty or failed payloads as no data", () => {
    for (const json of [null, undefined, "", { success: 0, data: { list: [] } }, { success: 1 }]) {
      expect(parseAnalystRating(json)).toBeNull();
      expect(parseConsensus(json)).toEqual([]);
      expect(parseEarningForecast(json)).toEqual([]);
      expect(parsePriceForecast(json)).toBeNull();
      expect(parseHitsMisses(json, "eps")).toEqual([]);
    }
  });
});

describe("date helpers", () => {
  it("maps month labels to month bounds", () => {
    expect(monthEnd("Mar 2027")).toBe("2027-03-31");
    expect(monthEnd("Feb 2028")).toBe("2028-02-29");
    expect(monthEnd("Sep '25")).toBe("2025-09-30");
    expect(monthStart("Oct 2026")).toBe("2026-10-01");
    expect(monthEnd("FY27")).toBeNull();
  });

  it("parses card dates with a PDF URL fallback", () => {
    expect(parseCardDate(" 12 Mar, 2026 ", null)).toBe("2026-03-12");
    expect(parseCardDate("5 September 2025", null)).toBe("2025-09-05");
    expect(
      parseCardDate(
        "-",
        "https://images.moneycontrol.com/static-mcnews/2025/11/20251120063554_Reliance.pdf",
      ),
    ).toBe("2025-11-20");
    expect(parseCardDate("-", "https://example.com/report.pdf")).toBeNull();
    expect(parseCardDate("-", null)).toBeNull();
  });
});
