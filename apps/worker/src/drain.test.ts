import { afterEach, describe, expect, it, vi } from "vitest";
import { ABORT_BEFORE_DRAIN_END_MS, type DrainSteps, drainInOrder } from "./drain.js";
import { ABORT_SETTLE_MS } from "./execute.js";

const DRAIN_MS = 90_000;
const RENEW_MS = 10_000;

function recorder(handlerMs: number, opts: { abortSettles?: boolean } = {}) {
  const events: Array<[string, number]> = [];
  const start = Date.now();
  const at = (name: string) => events.push([name, Date.now() - start]);
  let finishHandler = () => {};
  const inFlight = new Promise<void>((resolve) => {
    finishHandler = resolve;
    setTimeout(resolve, handlerMs);
  });
  const steps: DrainSteps = {
    stopClaims: async () => {
      at("stopClaims");
    },
    waitForInFlight: async (timeoutMs) => {
      at("wait");
      await Promise.race([inFlight, new Promise((r) => setTimeout(r, timeoutMs))]);
      at("drained");
    },
    renewLease: async () => {
      at("renew");
    },
    abortInFlight: () => {
      at("abort");
      if (opts.abortSettles) finishHandler();
    },
    releaseLease: async () => {
      at("release");
    },
  };
  return { events, steps };
}

describe("drainInOrder", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stops claims first, keeps renewing during a slow handler, and releases last", async () => {
    vi.useFakeTimers();
    const { events, steps } = recorder(45_000);
    const done = drainInOrder(steps, DRAIN_MS, RENEW_MS);
    await vi.advanceTimersByTimeAsync(DRAIN_MS);
    await done;
    const names = events.map(([n]) => n);
    expect(names[0]).toBe("stopClaims");
    expect(names.at(-1)).toBe("release");
    expect(events.filter(([n]) => n === "renew").map(([, t]) => t)).toEqual([
      10_000, 20_000, 30_000, 40_000,
    ]);
    expect(names).not.toContain("abort");
    expect(events.find(([n]) => n === "release")?.[1]).toBe(45_000);
  });

  it("aborts in-flight work before the drain window closes", async () => {
    vi.useFakeTimers();
    const { events, steps } = recorder(10 * 60_000, { abortSettles: true });
    const done = drainInOrder(steps, DRAIN_MS, RENEW_MS);
    await vi.advanceTimersByTimeAsync(DRAIN_MS);
    await done;
    const abortAt = DRAIN_MS - ABORT_BEFORE_DRAIN_END_MS;
    expect(abortAt).toBe(DRAIN_MS - ABORT_SETTLE_MS - 5_000);
    expect(events.find(([n]) => n === "abort")?.[1]).toBe(abortAt);
    expect(events.filter(([n]) => n === "renew")).toHaveLength(Math.floor(abortAt / RENEW_MS));
    expect(events.at(-1)).toEqual(["release", abortAt]);
  });
});
