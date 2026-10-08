import { describe, expect, it } from "vitest";
import { reconcileTriage, type TriageCandidate, triageItemInput } from "./triage.js";
import { isRoutineAnnouncement } from "./triage-rules.js";

describe("isRoutineAnnouncement", () => {
  it.each([
    "Closure of Trading Window",
    "Certificate under SEBI (Depositories and Participants) Regulations, 2018",
    "Compliance Certificate under Regulation 74 (5)",
    "Copy of Newspaper Publication",
    "Loss of Share Certificate",
    "Allotment of ESOP shares",
    "Intimation of Schedule of Analyst / Institutional Investor Meet",
    "Voting Results and Scrutinizer's Report",
    "Disclosure of Related Party Transactions for the half year ended March 31, 2026",
  ])("treats %s as routine", (subject) => {
    expect(isRoutineAnnouncement(subject)).toBe(true);
  });

  it.each([
    "Outcome of Board Meeting - Financial Results",
    "Acquisition of 51% stake in XYZ Ltd",
    "Receipt of order worth Rs 1,200 crore",
    "Credit Rating",
    "Postal Ballot Notice",
    "Shareholders Meeting",
    "Postal Ballot - Scheme of Amalgamation with ABC Ltd",
    "Shareholders meeting to approve acquisition of XYZ Ltd",
    "Disclosure of related party transactions - material related party transaction with promoter",
    "Record date for bonus issue",
  ])("keeps %s for the model", (subject) => {
    expect(isRoutineAnnouncement(subject)).toBe(false);
  });

  it("looks into details for generic subjects", () => {
    expect(
      isRoutineAnnouncement("General Updates", "Newspaper advertisement for notice of AGM"),
    ).toBe(true);
    expect(isRoutineAnnouncement("General Updates", "The company has won a large order")).toBe(
      false,
    );
  });

  it("lets material details override a routine subject", () => {
    expect(
      isRoutineAnnouncement(
        "Voting Results and Scrutinizer's Report",
        "Approval of the scheme of merger of the subsidiary into the company",
      ),
    ).toBe(false);
    expect(
      isRoutineAnnouncement("Newspaper advertisement", "Notice of buyback of equity shares"),
    ).toBe(false);
  });
});

const candidate = (
  id: number,
  subject: string,
  details: string | null = null,
): TriageCandidate => ({
  id,
  companyId: 1,
  symbol: "ACME",
  publishedAt: "2026-10-05T10:00:00Z",
  subject,
  category: null,
  details,
});

describe("reconcileTriage", () => {
  const batch = [candidate(1, "Order win worth Rs 1,200 crore"), candidate(2, "Change in CFO")];

  it("ignores unknown and duplicate ids", () => {
    const out = reconcileTriage(batch, [
      {
        announcementId: 1,
        category: "order",
        materiality: "high",
        soWhat: "Large order of 1,200 crore.",
      },
      { announcementId: 1, category: "other", materiality: "low", soWhat: "dup" },
      { announcementId: 99, category: "other", materiality: "low", soWhat: "unknown" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.item.category).toBe("order");
    expect(out[0]?.item.soWhat).toBe("Large order of 1,200 crore.");
  });

  it("falls back to the subject when soWhat has invented numbers", () => {
    const out = reconcileTriage(batch, [
      {
        announcementId: 2,
        category: "management",
        materiality: "medium",
        soWhat: "CFO exit hits 15% of value.",
      },
    ]);
    expect(out[0]?.item.soWhat).toBe("Change in CFO");
  });

  it("trims long details in the model input", () => {
    const input = triageItemInput(candidate(3, "x", `a  b\n${"c".repeat(600)}`));
    expect(input.details?.length).toBe(400);
    expect(input.details?.startsWith("a b c")).toBe(true);
  });
});
