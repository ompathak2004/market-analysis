import { describe, expect, it } from "vitest";
import {
  maskOutsideRationale,
  parseRatingRationale,
  ratingAgencyOfUrl,
  ratingDate,
  ratingDocumentUrl,
  ratingLinksIn,
} from "./ratings.js";

const ICRA = `June 14, 2026
Acme Components Limited: Ratings reaffirmed
Summary of rating action
Instrument | Previous Rated Amount | Current Rated Amount | Rating Action
Long-term fund based - Term loan | 100.00 | 100.00 | [ICRA]AA- (Stable); reaffirmed
Short-term non-fund based | 50.00 | 50.00 | [ICRA]A1+; reaffirmed
Rationale
The reaffirmation reflects the established relationship with Maruti Suzuki India Limited,
which accounted for 42% of revenues in FY2026.
Key rating drivers and their description
Credit strengths
Long track record with leading passenger vehicle OEMs.
Credit challenges
High customer concentration.
Liquidity position: Adequate
Rating sensitivities
Positive factors - Diversification of the customer base.
About the company
Acme Components manufactures steering parts for Maruti Suzuki and Tata Motors.
Key financial indicators
FY2025 | FY2026
`;

const CRISIL = `Rating Rationale
March 3, 2026 | Mumbai
Bharat Widgets Limited
Rating outlook revised to 'Positive'; Ratings Reaffirmed
Rating Action
Total Bank Loan Facilities Rated | Rs.500 Crore
Long Term Rating | CRISIL A+/Positive (Outlook revised from 'Stable'; Rating Reaffirmed)
Short Term Rating | CRISIL A1 (Reaffirmed)
Detailed Rationale
The outlook revision reflects stronger order inflows from Indian Railways.
Analytical Approach
Standalone.
Key Rating Drivers & Detailed Description
Strengths:
Healthy order book of Rs 2,000 crore from Indian Railways and BHEL.
Weaknesses:
Working capital intensity.
Outlook: Positive
`;

const CARE = `Press Release
Sunrise Power Limited
14-11-2025
Ratings
Facilities | Amount | Rating | Rating Action
Long Term Bank Facilities | 900.00 | CARE BBB+; Rating Watch with Negative Implications | Placed on watch
Rationale and key rating drivers
The rating is constrained by delays in payment from the state discom offtaker.
Key strengths
Long-term power purchase agreement with Tamil Nadu Generation and Distribution Corporation.
Key weaknesses
Counterparty credit risk.
Analytical approach: Standalone
`;

const IND = `India Ratings and Research (Ind-Ra) has affirmed Delta Cables Limited's Long-Term Issuer Rating at 'IND AA'. The Outlook is Stable.
2 Feb 2026
Key Rating Drivers
Diversified clientele including Power Grid Corporation.
Rating Sensitivities
Not applicable.
`;

describe("rating rationale parser", () => {
  it("parses an ICRA rationale and keeps only the rationale sections", () => {
    const parsed = parseRatingRationale(ICRA);
    expect(parsed).toMatchObject({
      agency: "icra",
      rating: "[ICRA]AA-",
      outlook: "stable",
      date: "2026-06-14",
    });
    expect(parsed.rationale).toContain("Maruti Suzuki India Limited");
    expect(parsed.rationale).toContain("High customer concentration");
    expect(parsed.rationale).toContain("steering parts");
    expect(parsed.rationale).not.toContain("Positive factors");
    expect(parsed.rationale).not.toContain("Summary of rating action");
    expect(parsed.rationale).not.toContain("FY2025 | FY2026");
  });

  it("parses CRISIL slash outlooks and strengths/weaknesses blocks", () => {
    const parsed = parseRatingRationale(CRISIL);
    expect(parsed).toMatchObject({
      agency: "crisil",
      rating: "CRISIL A+",
      outlook: "positive",
      date: "2026-03-03",
    });
    expect(parsed.rationale).toContain("Indian Railways and BHEL");
    expect(parsed.rationale).not.toContain("Standalone.");
  });

  it("parses CARE watches and day-first numeric dates", () => {
    const parsed = parseRatingRationale(CARE);
    expect(parsed).toMatchObject({
      agency: "care",
      rating: "CARE BBB+",
      outlook: "watch_negative",
      date: "2025-11-14",
    });
    expect(parsed.rationale).toContain("power purchase agreement");
  });

  it("parses India Ratings quoted symbols and stated outlooks", () => {
    const parsed = parseRatingRationale(IND);
    expect(parsed).toMatchObject({
      agency: "india_ratings",
      rating: "IND AA",
      outlook: "stable",
      date: "2026-02-02",
    });
  });

  it("does not read Ind AS references as ratings", () => {
    const parsed = parseRatingRationale("Segment information under IND AS 108 is given below.");
    expect(parsed.rating).toBeNull();
    expect(parsed.agency).toBeNull();
    expect(parsed.rationale).toBe("Segment information under IND AS 108 is given below.");
  });

  it("prefers the agency of the source host", () => {
    const text = "Earlier rated CRISIL AA by another agency.\nNow [ICRA]AA (Stable) assigned.";
    const parsed = parseRatingRationale(
      text,
      "https://www.icra.in/Rating/ShowRationalReportFilePdfViewer/1",
    );
    expect(parsed.agency).toBe("icra");
    expect(parsed.rating).toBe("[ICRA]AA");
  });

  it("masks non-rationale text without moving offsets", () => {
    const masked = maskOutsideRationale(ICRA);
    expect(masked.length).toBe(ICRA.length);
    const at = ICRA.indexOf("Maruti Suzuki India Limited");
    expect(masked.slice(at, at + 27)).toBe("Maruti Suzuki India Limited");
    expect(masked).not.toContain("Positive factors");
    expect(masked.split("\n").length).toBe(ICRA.split("\n").length);
  });

  it("finds agency links and maps ICRA viewer pages to PDFs", () => {
    expect(ratingAgencyOfUrl("https://www.crisilratings.com/x.pdf")).toBe("crisil");
    expect(ratingAgencyOfUrl("not a url")).toBeNull();
    expect(ratingDocumentUrl("https://www.icra.in/Rationale/ShowRationaleReport?Id=12345")).toBe(
      "https://www.icra.in/Rating/ShowRationalReportFilePdfViewer/12345",
    );
    expect(
      ratingLinksIn(
        "See https://www.icra.in/Rationale/ShowRationaleReport?Id=77. and https://example.com/a",
      ),
    ).toEqual(["https://www.icra.in/Rating/ShowRationalReportFilePdfViewer/77"]);
    expect(ratingLinksIn(null)).toEqual([]);
  });

  it("rejects impossible dates", () => {
    expect(ratingDate("Dated 31/02/2026 and 45-13-2026")).toBeNull();
  });
});
