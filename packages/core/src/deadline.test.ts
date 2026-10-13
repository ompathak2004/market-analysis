import { describe, expect, it, vi } from "vitest";
import {
  assertTimeLeft,
  currentDeadline,
  DeadlineExceededError,
  deadlineSignal,
  guardCommit,
  remainingMs,
  throwIfAborted,
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

  it("propagates an external abort to request signals and checkpoints in the scope", async () => {
    const ctl = new AbortController();
    await withDeadline(
      Date.now() + 60_000,
      async () => {
        const request = deadlineSignal(60_000);
        expect(() => throwIfAborted()).not.toThrow();
        ctl.abort(new Error("stopping"));
        expect(request.aborted).toBe(true);
        expect(() => throwIfAborted()).toThrow("stopping");
        expect(() => assertTimeLeft(10)).toThrow("stopping");
      },
      { signal: ctl.signal },
    );
  });

  it("runs the scope's commit guard, inherited by nested scopes", async () => {
    const seen: unknown[] = [];
    const commitGuard = async (tx: unknown) => {
      seen.push(tx);
    };
    await withDeadline(
      Date.now() + 60_000,
      () => withDeadline(Date.now() + 30_000, () => guardCommit("tx-1")),
      { commitGuard },
    );
    await guardCommit("outside");
    expect(seen).toEqual(["tx-1"]);
  });

  it("refuses to commit once the scope is aborted", async () => {
    const ctl = new AbortController();
    const commitGuard = vi.fn(async () => {});
    await withDeadline(
      Date.now() + 60_000,
      async () => {
        ctl.abort(new Error("stopping"));
        await expect(guardCommit("tx")).rejects.toThrow("stopping");
      },
      { signal: ctl.signal, commitGuard },
    );
    expect(commitGuard).not.toHaveBeenCalled();
  });
});
