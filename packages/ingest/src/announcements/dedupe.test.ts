import { sha256 } from "@ma/core";
import { describe, expect, it } from "vitest";
import { announcementDedupeKey } from "./dedupe.js";

describe("announcementDedupeKey", () => {
  const base = {
    symbol: "GRSE",
    publishedAt: new Date("2026-11-02T10:15:00Z"),
    subject: "Award of Order / Receipt of Order",
  };
  const path = "/corporate/GRSE_02112026101500_order.pdf";

  it("ignores the NSE .com/.in mirror and keeps legacy .com keys", () => {
    const com = announcementDedupeKey({
      ...base,
      attachmentUrl: `https://nsearchives.nseindia.com${path}`,
    });
    expect(
      announcementDedupeKey({ ...base, attachmentUrl: `https://nsearchives.nseindia.in${path}` }),
    ).toBe(com);
    expect(com).toBe(
      sha256(
        `GRSE|2026-11-02T10:15:00.000Z|${base.subject}|https://nsearchives.nseindia.com${path}`,
      ),
    );
    expect(announcementDedupeKey({ ...base, attachmentUrl: `https://example.in${path}` })).not.toBe(
      com,
    );
  });
});
