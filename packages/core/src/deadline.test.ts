import { describe, expect, it } from "vitest";
import {
  assertTimeLeft,
  currentDeadline,
  DeadlineExceededError,
  deadlineSignal,
  remainingMs,
  withDeadline,
} from "./deadline.js";

describe("deadline scope", () => {
  it("is unbounded outside a scope", () => {
    expect(currentDeadline()).toBeNull();
    expect(remainingMs()).toBe(Number.POSITIVE_INFINITY);
    expect(() => assertTimeLeft(1_000_000)).not.toThrow();
  });

  it("propagates through awaits and keeps the tighter of nested deadlines", async () => {
    const outer = Date.now() + 5_000;
    await withDeadline(outer, async () => {
      await new Promise((r) => setTimeout(r, 1));
      expect(currentDeadline()).toBe(outer);
      await withDeadline(outer + 60_000, async () => {
        expect(currentDeadline()).toBe(outer);
      });
      await withDeadline(outer - 4_000, async () => {
        expect(currentDeadline()).toBe(outer - 4_000);
      });
    });
    expect(currentDeadline()).toBeNull();
  });

  it("refuses work that cannot finish in time", async () => {
    await withDeadline(Date.now() + 1_000, async () => {
      expect(() => assertTimeLeft(5_000)).toThrow(DeadlineExceededError);
      expect(() => assertTimeLeft(10)).not.toThrow();
    });
  });

  it("caps request signals at the remaining time and aborts the scope signal", async () => {
    await withDeadline(Date.now() + 30, async (scopeSignal) => {
      const request = deadlineSignal(60_000);
      await new Promise((r) => setTimeout(r, 60));
      expect(request.aborted).toBe(true);
      expect(scopeSignal.aborted).toBe(true);
    });
  });

  it("aborts when an explicit signal aborts", () => {
    const ctl = new AbortController();
    const signal = deadlineSignal(60_000, ctl.signal);
    expect(signal.aborted).toBe(false);
    ctl.abort();
    expect(signal.aborted).toBe(true);
  });
});
