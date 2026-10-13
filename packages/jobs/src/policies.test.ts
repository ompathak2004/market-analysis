import { AppError, UpstreamError } from "@ma/core";
import { describe, expect, it } from "vitest";
import {
  asDeferred,
  BACKOFF_MAX_MS,
  backoffMs,
  DeferredError,
  isRetryable,
  NonRetryableError,
  parseRetryAfter,
  retryDelayMs,
} from "./policies.js";

describe("retry policies", () => {
  it("backs off exponentially with a cap", () => {
    expect(backoffMs(1, () => 1)).toBe(30_000);
    expect(backoffMs(2, () => 1)).toBe(60_000);
    expect(backoffMs(1, () => 0)).toBe(15_000);
    expect(backoffMs(20, () => 1)).toBe(BACKOFF_MAX_MS);
  });

  it("honours Retry-After hints", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(parseRetryAfter("120", now)).toBe(120_000);
    expect(parseRetryAfter("Thu, 01 Jan 2026 00:01:00 GMT", now)).toBe(60_000);
    expect(parseRetryAfter("soon", now)).toBeNull();
    const err = new AppError("rate limited", "upstream_error", 429, { retryAfterMs: 600_000 });
    expect(retryDelayMs(1, err, () => 1)).toBe(600_000);
  });

  it("classifies non-retryable errors", () => {
    expect(isRetryable(new Error("boom"))).toBe(true);
    expect(isRetryable(new NonRetryableError("bad input"))).toBe(false);
    expect(isRetryable(new AppError("bad", "llm_invalid_output"))).toBe(false);
  });

  it("defers budget exhaustion to the next window", () => {
    const now = new Date("2026-03-15T10:00:00Z");
    const llm = asDeferred(new AppError("budget", "llm_budget_exceeded"), now, () => 0);
    expect(llm?.resumeAt.toISOString()).toBe("2026-03-16T00:00:00.000Z");
    const firecrawl = asDeferred(
      new UpstreamError("firecrawl", "monthly budget exhausted"),
      now,
      () => 0,
    );
    expect(firecrawl?.resumeAt.toISOString()).toBe("2026-04-01T00:00:00.000Z");
    const explicit = new DeferredError(new Date("2026-03-15T11:00:00Z"), "later");
    expect(asDeferred(explicit, now)).toBe(explicit);
    expect(asDeferred(new Error("plain"), now)).toBeNull();
  });
});
