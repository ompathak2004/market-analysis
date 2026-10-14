import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { HttpClient } from "../http.js";
import {
  aggregateRpt,
  isHalfYearEnd,
  NseRptSource,
  parseIntegratedRpt,
  parseRptMaster,
  parseRptXbrl,
  rptSnapshot,
} from "./nse-rpt.js";

const fixture = (name: string) =>
  readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8");

const response = (status: number, body: string, type: string) => ({
  status,
  text: () => body,
  headers: new Headers({ "content-type": type }),
});

describe("NSE related party filings", () => {
  it("parses the legacy RPT master", () => {
    const filings = parseRptMaster(fixture("nse-rpt-master.json"));
    expect(filings).toHaveLength(2);
    expect(filings[0]).toMatchObject({
      id: "63893",
      kind: "legacy",
      symbol: "TCS",
      periodStart: "2024-04-01",
      periodEnd: "2024-09-30",
      revised: false,
    });
    expect(filings[0]?.xbrlUrl).toMatch(/RPT_1265399/);
  });

  it("keeps only standalone half-year integrated financials", () => {
    const filings = parseIntegratedRpt(fixture("nse-integrated-financials.json"));
    expect(filings).toHaveLength(1);
    expect(filings[0]).toMatchObject({
      kind: "integrated",
      periodEnd: "2026-03-31",
      periodStart: null,
    });
    expect(filings[0]?.xbrlUrl).toMatch(/1648407/);
  });

  it("knows half-year period ends", () => {
    expect(isHalfYearEnd("2026-03-31")).toBe(true);
    expect(isHalfYearEnd("2025-09-30")).toBe(true);
    expect(isHalfYearEnd("2026-06-30")).toBe(false);
  });
});

describe("NSE related party XBRL", () => {
  const report = parseRptXbrl(fixture("nse-rpt.xbrl.xml"));

  it("reads the header and every transaction row", () => {
    expect(report).toMatchObject({
      symbol: "TCS",
      companyName: "Tata Consultancy Services Limited",
      periodStart: "2024-04-01",
      periodEnd: "2024-09-30",
    });
    expect(report.rows).toHaveLength(13);
  });

  it("converts INR to crore and prefers the detail for other transactions", () => {
    const brand = report.rows.find((r) => r.transactionType === "Brand equity contribution");
    expect(brand).toEqual({
      entity: "Tata Consultancy Services Limited",
      counterparty: "Tata Sons Private Limited",
      relationship: "Holding Company",
      transactionType: "Brand equity contribution",
      valueCr: 100,
    });
    const sale = report.rows.find((r) => r.transactionType === "Sale of goods or services");
    expect(sale?.valueCr).toBe(33);
  });

  it("stores the magnitude of a net outflow reported as a negative amount", () => {
    const xml = fixture("nse-rpt.xbrl.xml").replace(
      /(contextRef="D_RelatedPartyTransaction2" decimals="-7" unitRef="INR">)10000000/,
      "$1-10000000",
    );
    const row = parseRptXbrl(xml).rows.find((r) => r.counterparty === "Tata Motors Limited");
    expect(row?.valueCr).toBe(1);
  });

  it("keeps people named as key management personnel", () => {
    const kmp = report.rows.filter((r) => r.relationship === "Key Management Personnel");
    expect(kmp.map((r) => r.counterparty)).toContain("Mr. K Krithivasan");
  });

  it("aggregates duplicate rows and tags subsidiary scope", () => {
    const rows = aggregateRpt(report, "Tata Consultancy Services Limited");
    expect(rows).toHaveLength(12);
    const diligenta = rows.find((r) => r.counterparty === "Diligenta Limited");
    expect(diligenta).toMatchObject({ rows: 2, valueCr: 2, scope: "listed" });
    const chile = rows.find((r) => r.entity === "Tata Consultancy Services Chile S.A.");
    expect(chile?.scope).toBe("subsidiary");
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
  });

  it("builds a deterministic snapshot with a span per aggregate", () => {
    const [filing] = parseRptMaster(fixture("nse-rpt-master.json"));
    if (!filing) throw new Error("fixture has no filing");
    const rows = aggregateRpt(report, "Tata Consultancy Services Limited");
    const a = rptSnapshot(filing, report, rows);
    const b = rptSnapshot(
      filing,
      report,
      [...rows].reverse().sort((x, y) => x.key.localeCompare(y.key)),
    );
    expect(a.content).toBe(b.content);
    expect(JSON.parse(a.content).transactions).toHaveLength(rows.length);
    for (const row of rows) {
      const span = a.spans.get(row.key);
      expect(JSON.parse(a.content.slice(span?.start, span?.end))).toMatchObject({
        counterparty: row.counterparty,
        valueCr: row.valueCr,
      });
    }
  });
});

describe("NseRptSource", () => {
  it("merges integrated and legacy filings latest first", async () => {
    const http = {
      get: async (url: string) =>
        url.includes("integrated-filing")
          ? response(200, fixture("nse-integrated-financials.json"), "application/json")
          : response(200, fixture("nse-rpt-master.json"), "application/json"),
    } as unknown as HttpClient;
    const filings = await new NseRptSource(http, "https://www.nseindia.com").filings("TCS");
    expect(filings.map((f) => [f.kind, f.periodEnd])).toEqual([
      ["integrated", "2026-03-31"],
      ["legacy", "2024-09-30"],
      ["legacy", "2024-03-31"],
    ]);
  });
});
