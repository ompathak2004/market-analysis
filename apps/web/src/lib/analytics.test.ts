import type { CaptureResult } from "posthog-js";
import { describe, expect, it } from "vitest";
import { publicPageEvent } from "./analytics";

function pageEvent(url: string, event = "$pageview"): CaptureResult {
  return {
    uuid: "019a0020-0000-7000-8000-000000000001",
    event,
    properties: { $current_url: url, distinct_id: "anonymous-visitor" },
  };
}

describe("public page analytics", () => {
  it("keeps public page and tab visits, including page leaves", () => {
    for (const path of ["/", "/help", "/c/RELIANCE/des", "/c/RELIANCE/splc", "/signals"]) {
      for (const name of ["$pageview", "$pageleave"]) {
        const event = pageEvent(`https://terminal.example${path}`, name);
        expect(publicPageEvent(event)).toBe(event);
      }
    }
  });

  it("drops admin and API activity using the event URL, including outgoing page leaves", () => {
    for (const path of [
      "/admin",
      "/admin/login",
      "/admin/review?sample=private",
      "/api/v1/search",
    ]) {
      for (const name of ["$pageview", "$pageleave"]) {
        expect(publicPageEvent(pageEvent(`https://terminal.example${path}`, name))).toBeNull();
      }
    }
  });

  it("drops other event types and missing or invalid URLs", () => {
    expect(publicPageEvent(pageEvent("https://terminal.example/", "$autocapture"))).toBeNull();
    expect(publicPageEvent(pageEvent("invalid-url"))).toBeNull();
    const missingUrl = pageEvent("https://terminal.example/");
    delete missingUrl.properties.$current_url;
    expect(publicPageEvent(missingUrl)).toBeNull();
    expect(publicPageEvent(null)).toBeNull();
  });
});
