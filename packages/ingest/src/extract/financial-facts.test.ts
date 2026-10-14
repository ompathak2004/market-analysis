import { describe, expect, it } from "vitest";
import { extractFinancialFacts, type FinancialFact } from "./financial-facts.js";

const FY25 = "2025-03-31";

const GROUP_REPORT = `
Contents
Standalone Statement of Profit and Loss ........ 148
Consolidated Statement of Profit and Loss ........ 212

Independent Auditor's Report
We have audited the accompanying consolidated financial statements, which comprise the
Consolidated Balance Sheet as at March 31, 2025, the Consolidated Statement of Profit and Loss
for the year then ended. Revenue from operations of ₹ 12,345 crore is a key audit matter.

Standalone Statement of Profit and Loss for the year ended March 31, 2025
(₹ in crore)
Particulars Note Year ended March 31, 2025 Year ended March 31, 2024
I Revenue from operations 24 9,876.50 9,100.25
II Other income 25 120.40 98.10
III Total income 9,996.90 9,198.35
IV Expenses
Cost of materials consumed 26 5,100.00 4,800.00
Employee benefits expense 27 900.00 850.00
Total expenses 8,000.00 7,600.00

Standalone Statement of Changes in Equity for the year ended March 31, 2025

Consolidated Statement of Profit and Loss for the year ended March 31, 2025
(All amounts in ₹ crore, unless otherwise stated)
Particulars Note Year ended March 31, 2025 Year ended March 31, 2024
Income
Revenue from operations (Refer Note 27) 27 12,345.67 11,234.56
Other income 28 210.00 180.00
Total income 12,555.67 11,414.56
Expenses
Cost of materials consumed 29 6,543.21 6,000.00
Purchases of stock-in-trade 30 1,234.50 1,100.00
Changes in inventories of finished goods, work-in-progress and stock-in-trade 31 ( 345.60 ) 120.00
Employee benefits expense 32 1,500.00 1,400.00
Finance costs 33 200.00 210.00
Other expenses 35 1,800.00 1,700.00
Total expenses 11,332.11 10,910.00
Profit attributable to:
Owners of the parent 900.00 400.00
Non-controlling interests 23.56 4.56
Earnings per equity share (face value ₹ 10 each)
Basic (₹) 36 9.00 4.00

Consolidated Statement of Changes in Equity for the year ended March 31, 2025
Equity share capital 100.00 100.00

Consolidated Statement of Cash Flows for the year ended March 31, 2025
(₹ in crore)
A. Cash flow from operating activities
Profit before tax 1,223.56 504.56
B. Cash flow from investing activities
Purchase of property, plant and equipment (including capital work-in-progress) (987.65) (800.00)
Proceeds from sale of property, plant and equipment 12.00 10.00
`;

const LAKH_REPORT = [
  "STATEMENT OF PROFIT AND LOSS FOR THE YEAR ENDED 31ST MARCH, 2025 (Rs. in Lakhs)",
  "Particulars 2024-25 2023-24 Revenue from operations 45,678.90 40,123.45",
  "Other income 123.45 100.00 Total Income 45,802.35 40,223.45 Expenses",
  "Purchases of traded goods 30,000.00 27,000.00",
  "Changes in inventories of stock-in-trade 1,250.00 (500.00)",
  "Employee benefits expense 4,000.00 3,500.00 Research and development expenses 600.00 550.00",
  "Other expenses 5,000.00 4,800.00 Total expenses 40,850.00 34,850.00",
  "STATEMENT OF CASH FLOWS FOR THE YEAR ENDED 31ST MARCH, 2025 (Rs. in Lakhs)",
  "Net cash from operating activities 3,000.00 2,500.00",
  "Purchase of property, plant and equipment (2,345.00) (1,000.00)",
].join(" ");

const MILLION_REPORT = `
Consolidated Statement of Profit and Loss
for the year ended 31.03.2025
(INR in million)
Particulars Notes 31.03.2025 31.03.2024
Revenue from operations 21(a) 54,321.0 50,000.0
Other income 21(b) 400.0 380.0
Cost of raw materials consumed 22 20,000.0 19,000.0
Purchases of stock-in-trade 23 - 150.0
(Increase)/decrease in inventories of finished goods and work-in-progress 24 1,500.0 (2,000.0)
Employee benefits expense 25 6,000.0 5,500.0
Profit for the year attributable to non-controlling interests 10.0 8.0
`;

const FOOTER_REPORT = `Annual Report 2024-25 162
Particulars Note Year ended
March 31, 2025
Year ended
March 31, 2024
Revenue from operations 24 82,705.22 77,826.68
Cost of materials consumed 26 43,057.70 41,158.83
Purchase of stock-in-trade 27 405.92 495.76
Changes in inventories of finished goods, stock in trade and work in progress 28 (528.56) 593.84
Employee benefits expenses 29 9,225.85 8,111.90
This is the statement of profit or loss referred to in our report of even date.
STATEMENT OF CONSOLIDATED PROFIT AND LOSS
for the year ended March 31, 2025 (All amounts in \` Lacs, unless otherwise stated)
For and on behalf of the Board

Annual Report 2024-25 164
Net cash generated from operating activities (A) 8,001.93 6,674.91
Payment for Purchase of Fixed Assets (including capital
work-in-progress)
(5,378.42) (6,009.98)
This is the statement of cash flow referred to in our report of even date.
CONSOLIDATED CASH FLOW STATEMENT
as at March 31, 2025 (All amounts in \` Lacs, unless otherwise stated)
`;

function byMetric(facts: readonly FinancialFact[]): Record<string, number> {
  return Object.fromEntries(facts.map((f) => [f.metric, f.valueCr]));
}

describe("extractFinancialFacts", () => {
  it("prefers the consolidated statement and skips note numbers", () => {
    const r = extractFinancialFacts(GROUP_REPORT, FY25);
    expect(r?.statement).toBe("consolidated");
    expect(r?.unit).toBe("crore");
    expect(byMetric(r?.facts ?? [])).toEqual({
      revenue: 12_345.67,
      purchases: 7_777.71,
      cogs: 7_432.11,
      capex: 987.65,
    });
  });

  it("reads a flattened standalone statement in lakhs", () => {
    const r = extractFinancialFacts(LAKH_REPORT, FY25);
    expect(r?.statement).toBe("standalone");
    expect(r?.unit).toBe("lakh");
    expect(byMetric(r?.facts ?? [])).toEqual({
      revenue: 456.79,
      purchases: 300,
      cogs: 312.5,
      rnd: 6,
      capex: 23.45,
    });
  });

  it("converts millions and reads an (increase)/decrease inventory line", () => {
    const r = extractFinancialFacts(MILLION_REPORT, FY25);
    expect(r?.statement).toBe("consolidated");
    expect(r?.unit).toBe("million");
    expect(byMetric(r?.facts ?? [])).toEqual({
      revenue: 5_432.1,
      purchases: 2_000,
      cogs: 2_150,
    });
  });

  it("falls back to the standalone statement when no consolidated one parses", () => {
    const standaloneOnly = GROUP_REPORT.split("Consolidated Statement of Profit and Loss for")[0];
    const r = extractFinancialFacts(standaloneOnly ?? "", FY25);
    expect(r?.statement).toBe("standalone");
    expect(byMetric(r?.facts ?? [])).toEqual({
      revenue: 9_876.5,
      purchases: 5_100,
      cogs: 5_100,
    });
  });

  it("reads statements whose heading is printed below the table", () => {
    const r = extractFinancialFacts(FOOTER_REPORT, FY25);
    expect(r?.statement).toBe("consolidated");
    expect(r?.unit).toBe("lakh");
    expect(byMetric(r?.facts ?? [])).toEqual({
      revenue: 827.05,
      purchases: 434.64,
      cogs: 429.35,
      capex: 53.78,
    });
  });

  it("refuses a statement for another year or without a unit header", () => {
    expect(extractFinancialFacts(GROUP_REPORT, "2024-03-31")).toBeNull();
    expect(extractFinancialFacts(MILLION_REPORT.replace("(INR in million)", ""), FY25)).toBeNull();
  });

  it("refuses a heading whose year-end date it cannot read", () => {
    const vague = MILLION_REPORT.replace(
      "for the year ended 31.03.2025",
      "for the year ended 31 Mar., 2O25",
    );
    expect(extractFinancialFacts(vague, FY25)).toBeNull();
  });

  it("reads a hyphenated year-end date", () => {
    const hyphenated = MILLION_REPORT.replace(
      "for the year ended 31.03.2025",
      "for the year ended 31-March-2025",
    );
    expect(byMetric(extractFinancialFacts(hyphenated, FY25)?.facts ?? []).revenue).toBe(5_432.1);
  });

  it("does not shift a short row into the previous year when the statement has a note column", () => {
    const shortRow = GROUP_REPORT.replace(
      "Changes in inventories of finished goods, work-in-progress and stock-in-trade 31 ( 345.60 ) 120.00",
      "Changes in inventories of finished goods, work-in-progress and stock-in-trade 50 (120.00)",
    );
    expect(byMetric(extractFinancialFacts(shortRow, FY25)?.facts ?? [])).toEqual({
      revenue: 12_345.67,
      purchases: 7_777.71,
      capex: 987.65,
    });
    const noted = GROUP_REPORT.replace(
      "Changes in inventories of finished goods, work-in-progress and stock-in-trade 31 ( 345.60 ) 120.00",
      "Changes in inventories of finished goods, work-in-progress and stock-in-trade 31a (120.00)",
    );
    expect(byMetric(extractFinancialFacts(noted, FY25)?.facts ?? []).cogs).toBe(7_657.71);
  });
});
