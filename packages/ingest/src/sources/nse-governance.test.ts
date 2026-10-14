import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { HttpClient } from "../http.js";
import { NseBlockedError } from "./nse.js";
import {
  directorKey,
  directorRole,
  governanceSnapshot,
  NseGovernanceSource,
  parseGovernanceMaster,
  parseGovernanceXbrl,
  parseIntegratedGovernance,
} from "./nse-governance.js";

const fixture = (name: string) =>
  readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8");

const response = (status: number, body: string, type: string) => ({
  status,
  text: () => body,
  headers: new Headers({ "content-type": type }),
});

describe("NSE governance filings", () => {
  it("parses the integrated governance list", () => {
    const filings = parseIntegratedGovernance(fixture("nse-governance-integrated.json"));
    expect(filings).toHaveLength(2);
    expect(filings[0]).toMatchObject({
      kind: "integrated",
      symbol: "TCS",
      periodEnd: "2026-06-30",
      revised: false,
    });
    expect(filings[0]?.xbrlUrl).toMatch(/^https:\/\/nsearchives\.nseindia\.com\//);
    expect(filings[0]?.submittedAt?.toISOString()).toBe("2026-07-30T05:08:24.000Z");
  });

  it("parses the legacy governance master", () => {
    const filings = parseGovernanceMaster(fixture("nse-governance-master.json"));
    expect(filings).toHaveLength(2);
    expect(filings[0]).toMatchObject({
      id: "104908",
      kind: "legacy",
      symbol: "TCS",
      companyName: "Tata Consultancy Services Limited",
      periodEnd: "2024-12-31",
    });
    expect(filings[0]?.submittedAt?.toISOString()).toBe("2025-02-10T06:23:00.000Z");
  });

  it("skips rows without an XBRL link", () => {
    const json = JSON.stringify({ data: [{ symbol: "TCS", date: "31-DEC-2024", xbrl: "-" }] });
    expect(parseGovernanceMaster(json)).toEqual([]);
  });
});

describe("NSE governance XBRL", () => {
  const report = parseGovernanceXbrl(fixture("nse-governance.xbrl.xml"));

  it("reads the header", () => {
    expect(report).toMatchObject({
      symbol: "TCS",
      isin: "INE467B01029",
      companyName: "TATA CONSULTANCY SERVICES LIMITED",
      periodEnd: "2026-06-30",
    });
  });

  it("reads every director with DIN, role and status", () => {
    expect(report.directors.map((d) => [d.din, d.role, d.status])).toEqual([
      ["00121863", "chairman", "current"],
      ["10106739", "md", "current"],
      ["03611983", "independent_director", "current"],
      ["99887766", "director", "past"],
    ]);
    const chair = report.directors[0];
    expect(chair).toMatchObject({
      name: "Chandrasekaran Natarajan",
      independent: false,
      executive: false,
      promoterRelated: true,
      birthYear: 1963,
    });
    expect(report.directors[1]).toMatchObject({ executive: true, appointedOn: "2023-06-01" });
    expect(report.directors[2]).toMatchObject({
      independent: true,
      reappointedOn: "2023-01-11",
      category: "Non-Executive - Independent Director",
    });
    expect(report.directors[3]).toMatchObject({ ceasedOn: "2026-05-15", independent: false });
  });

  it("never carries PAN or full date of birth", () => {
    const text = JSON.stringify(report);
    expect(text).not.toMatch(/\*{6}/);
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(Object.keys(report.directors[0] ?? {})).not.toContain("pan");
  });

  it("rejects a non-XBRL body", () => {
    expect(() => parseGovernanceXbrl("<html>blocked</html>")).toThrow(/XBRL/);
  });
});

describe("governance snapshot", () => {
  const report = parseGovernanceXbrl(fixture("nse-governance.xbrl.xml"));
  const [filing] = parseIntegratedGovernance(fixture("nse-governance-integrated.json"));

  it("is deterministic and spans each director", () => {
    if (!filing) throw new Error("fixture has no filing");
    const a = governanceSnapshot(filing, report);
    const b = governanceSnapshot(filing, { ...report, directors: [...report.directors].reverse() });
    expect(a.content).toBe(b.content);
    expect(() => JSON.parse(a.content)).not.toThrow();
    for (const d of report.directors) {
      const span = a.spans.get(directorKey(d));
      expect(span).toBeDefined();
      const line = a.content.slice(span?.start, span?.end);
      expect(JSON.parse(line)).toMatchObject({ din: d.din, name: d.name });
    }
  });
});

describe("directorRole", () => {
  it("classifies positions", () => {
    expect(directorRole(["Executive Director", "CEO-MD"])).toBe("md");
    expect(directorRole(["Non-Executive - Independent Director", "Chairperson"])).toBe("chairman");
    expect(directorRole(["Non-Executive - Non Independent Director"])).toBe("director");
    expect(directorRole(["Executive Director", "CFO"])).toBe("cfo");
    expect(directorRole(["Non-Executive - Independent Director"])).toBe("independent_director");
  });
});

describe("NseGovernanceSource", () => {
  const http = (handler: (url: string) => ReturnType<typeof response>) =>
    ({ get: async (url: string) => handler(url) }) as unknown as HttpClient;

  it("merges both masters latest first and survives one failing", async () => {
    const source = new NseGovernanceSource(
      http((url) =>
        url.includes("integrated-filing")
          ? response(200, fixture("nse-governance-integrated.json"), "application/json")
          : response(500, "", "text/plain"),
      ),
      "https://www.nseindia.com",
    );
    const filings = await source.filings("TCS");
    expect(filings.map((f) => f.periodEnd)).toEqual(["2026-06-30", "2026-03-31"]);
  });

  it("raises a blocked error when the XBRL comes back as HTML", async () => {
    const source = new NseGovernanceSource(
      http(() => response(200, "<html></html>", "text/html")),
      "https://www.nseindia.com",
    );
    await expect(
      source.report({
        id: "1",
        kind: "integrated",
        symbol: "TCS",
        companyName: "TCS",
        periodEnd: "2026-06-30",
        submittedAt: null,
        revised: false,
        xbrlUrl: "https://nsearchives.nseindia.com/x.xml",
      }),
    ).rejects.toBeInstanceOf(NseBlockedError);
  });
});
