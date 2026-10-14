import { describe, expect, it } from "vitest";
import {
  ANNOUNCEMENT_POLICY_VERSION,
  announcementPolicy,
  classifyAnnouncement,
  retainUntil,
} from "./policy.js";

describe("classifyAnnouncement", () => {
  it.each([
    ["Bagging/Receiving of orders/contracts", "order_win", "forever"],
    ["Receipt of order worth Rs 1,200 crore from NHAI", "order_win", "forever"],
    ["Outcome of Board Meeting - Financial Results", "results", "forever"],
    ["Integrated Filing- Financial", "results", "forever"],
    ["Credit Rating", "credit_rating", "forever"],
    ["Acquisition of 51% stake in XYZ Ltd", "acquisition", "forever"],
    [
      "Disclosure of Related Party Transactions for the half year ended March 31, 2026",
      "rpt",
      "forever",
    ],
    ["Investor Presentation", "investor_presentation", "forever"],
    [
      "Change in Directors/ Key Managerial Personnel/ Auditor/ Compliance Officer/ Share Transfer Agent",
      "resignation_appointment",
      "forever",
    ],
    ["Resignation of Chief Financial Officer", "resignation_appointment", "forever"],
    ["Board Meeting Intimation", "board_meeting", "five_years"],
    ["Record Date", "record_date", "five_years"],
    ["Shareholders meeting", "agm_egm", "five_years"],
    ["Dividend", "dividend", "five_years"],
    ["Buyback", "buyback", "five_years"],
    ["Shareholding Pattern", "shareholding", "five_years"],
    ["Spurt in Volume", "other", "five_years"],
    ["Closure of Trading Window", "trading_window", "noise"],
    ["Loss of Share Certificate", "loss_of_share_certificate", "noise"],
    ["Issue of Duplicate Share Certificate", "duplicate_share_certificate", "noise"],
    ["Copy of Newspaper Publication", "newspaper_publication", "noise"],
    ["Compliance Certificate under Regulation 74 (5)", "compliance_certificate", "noise"],
    [
      "Certificate under SEBI (Depositories and Participants) Regulations, 2018",
      "compliance_certificate",
      "noise",
    ],
    ["Certificate under Reg. 40(9) of SEBI LODR", "compliance_certificate", "noise"],
    ["Compliance under Regulation 7(3)", "compliance_certificate", "noise"],
    ["Statement of Investor Complaints", "investor_complaints", "noise"],
    ["Allotment of ESOP shares", "esop_allotment", "noise"],
    [
      "Intimation of Schedule of Analyst / Institutional Investor Meet",
      "concall_schedule",
      "noise",
    ],
  ] as const)("classifies %s as %s/%s", (subject, categoryKey, retentionClass) => {
    expect(classifyAnnouncement({ subject })).toEqual({ categoryKey, retentionClass });
  });

  it("reads details behind the generic con-call subject", () => {
    const subject = "Analysts/Institutional Investor Meet/Con. Call Updates";
    expect(
      classifyAnnouncement({
        subject,
        details: "The company has informed the Exchange about Transcript of the earnings call",
      }),
    ).toEqual({ categoryKey: "concall_transcript", retentionClass: "forever" });
    expect(
      classifyAnnouncement({
        subject,
        details: "The company has informed the Exchange about Schedule of meet",
      }),
    ).toEqual({ categoryKey: "concall_schedule", retentionClass: "noise" });
  });

  it("reads details behind generic update subjects", () => {
    expect(
      classifyAnnouncement({
        subject: "General Updates",
        details: "The company has received a work order worth Rs 300 crore",
      }),
    ).toEqual({ categoryKey: "order_win", retentionClass: "forever" });
    expect(
      classifyAnnouncement({
        subject: "General Updates",
        details: "Newspaper advertisement for notice of AGM",
      }),
    ).toEqual({ categoryKey: "newspaper_publication", retentionClass: "noise" });
  });

  it("keeps procedural filings that carry a material event", () => {
    expect(
      classifyAnnouncement({
        subject: "Copy of Newspaper Publication",
        details: "Notice of buyback of equity shares",
      }),
    ).toEqual({ categoryKey: "newspaper_publication", retentionClass: "five_years" });
  });

  it("keeps ESOP allotments above the routine size", () => {
    expect(
      classifyAnnouncement({
        subject: "Allotment of ESOP shares",
        details: "Allotment of 2,500,000 equity shares under ESOP 2021",
      }),
    ).toEqual({ categoryKey: "esop_allotment", retentionClass: "five_years" });
    expect(
      classifyAnnouncement({
        subject: "Allotment of ESOP shares",
        details: "Allotment of 12,400 equity shares under ESOP 2021",
      }),
    ).toEqual({ categoryKey: "esop_allotment", retentionClass: "noise" });
  });

  it("uses a distinct NSE category label when present", () => {
    expect(classifyAnnouncement({ subject: "Updates", category: "Credit Rating" })).toEqual({
      categoryKey: "credit_rating",
      retentionClass: "forever",
    });
  });
});

describe("retainUntil", () => {
  const published = new Date("2021-03-15T10:30:00Z");

  it("keeps forever and held rows without an expiry", () => {
    expect(retainUntil(published, "forever")).toBeNull();
    expect(retainUntil(published, "review_hold")).toBeNull();
  });

  it("expires five-year rows on the fifth anniversary", () => {
    expect(retainUntil(published, "five_years")).toBe("2026-03-15");
    expect(retainUntil(new Date("2024-02-29T00:00:00Z"), "five_years")).toBe("2029-03-01");
  });

  it("expires noise on the publication day", () => {
    expect(retainUntil(published, "noise")).toBe("2021-03-15");
  });

  it("builds the stored policy columns", () => {
    expect(announcementPolicy({ subject: "Dividend", publishedAt: published })).toEqual({
      categoryKey: "dividend",
      retentionClass: "five_years",
      retainUntil: "2026-03-15",
      policyVersion: ANNOUNCEMENT_POLICY_VERSION,
    });
  });
});
