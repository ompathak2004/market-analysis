import { AppError } from "@ma/core";
import { DeferredError, type FinishInput, type Lease, NonRetryableError } from "@ma/jobs";
import type { EnqueueRequest } from "@ma/jobs/queue";
import { describe, expect, it } from "vitest";
import type { WorkerContext } from "./context.js";
import {
  type ExecutorDeps,
  executeJob,
  LeaseLostError,
  type LedgerPort,
  WorkerStoppingError,
} from "./execute.js";
import type { Handler, HandlerMap } from "./registry.js";

const LEASE: Lease = { name: "consumer", ownerId: "owner", generation: 1 };
const NOW = Date.parse("2026-03-15T10:00:00Z");

interface Harness {
  deps: ExecutorDeps;
  finished: FinishInput[];
  retries: EnqueueRequest<never>[];
  spawned: { source: string; children: unknown[] }[];
  roots: unknown[];
  invalidated: string[];
  counts: Record<string, number>;
}

function harness(
  handler: Handler,
  opts: { started?: number | null; stop?: AbortSignal } = {},
): Harness {
  const h: Omit<Harness, "deps"> = {
    finished: [],
    retries: [],
    spawned: [],
    roots: [],
    invalidated: [],
    counts: {},
  };
  const ledger: LedgerPort = {
    ensureRun: async () => 11,
    startAttempt: async () => (opts.started === undefined ? 21 : opts.started),
    finishAttempt: async (input) => {
      h.finished.push(input);
      return true;
    },
    spawnChildren: async (source, children) => {
      h.spawned.push({ source, children });
      return { campaignId: 31, enqueued: children.length };
    },
    recordRoot: async (outcome) => {
      h.roots.push(outcome);
    },
  };
  const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };
  const deps: ExecutorDeps = {
    ctx: {} as WorkerContext,
    handlers: new Proxy({}, { get: () => handler }) as HandlerMap,
    ledger,
    retry: {
      send: async (request) => {
        h.retries.push(request as EnqueueRequest<never>);
        return { jobId: "retry", runId: request.runId ?? null, unitKey: "" };
      },
    },
    lease: () => LEASE,
    stop: opts.stop ?? new AbortController().signal,
    metrics: {
      count: (name, value = 1) => {
        h.counts[name] = (h.counts[name] ?? 0) + value;
      },
      flush: async () => undefined,
    },
    invalidate: async (family) => {
      h.invalidated.push(family);
    },
    logger: silent,
    now: () => NOW,
    random: () => 0,
  };
  return { ...h, deps };
}

const pricesJob = (retryCount = 0, extra: Record<string, unknown> = {}) => ({
  id: "job-1",
  retryCount,
  data: { type: "prices.sync", payload: { companyId: 5 }, ...extra },
});

describe("executeJob", () => {
  it("records success, writes a root run and invalidates the family", async () => {
    const h = harness(async () => ({ metrics: { rows: 2 } }));
    const report = await executeJob(h.deps, pricesJob());
    expect(report).toMatchObject({ outcome: "succeeded", runId: 11, attempt: 1 });
    expect(h.finished[0]).toMatchObject({
      outcome: "succeeded",
      metrics: { rows: 2 },
      attemptId: 21,
    });
    expect(h.roots).toHaveLength(1);
    expect(h.invalidated).toEqual(["prices"]);
    expect(h.counts["jobs.succeeded"]).toBe(1);
  });

  it("skips the root run for campaign children", async () => {
    const h = harness(async () => ({ metrics: {} }));
    await executeJob(h.deps, pricesJob(0, { campaignId: 4, runId: 9 }));
    expect(h.roots).toHaveLength(0);
    expect(h.finished[0]).toMatchObject({ runId: 9, campaignId: 4 });
  });

  it("spawns a campaign for fanout children", async () => {
    const h = harness(async () => ({
      metrics: { children: 2 },
      children: [
        { type: "prices.sync", payload: { companyId: 1 } },
        { type: "prices.sync", payload: { companyId: 2 } },
      ],
    }));
    const report = await executeJob(h.deps, {
      id: "j",
      retryCount: 0,
      data: { type: "prices.fanout" },
    });
    expect(report.metrics).toMatchObject({ enqueued: 2, campaignId: 31 });
    expect(h.spawned[0]?.source).toBe("prices");
    expect(h.invalidated).toEqual([]);
  });

  it("schedules an app-managed retry for retryable failures", async () => {
    const h = harness(async () => {
      throw new Error("socket hang up");
    });
    const report = await executeJob(h.deps, pricesJob());
    expect(report.outcome).toBe("failed");
    expect(h.finished[0]?.outcome).toBe("failed");
    expect(h.retries[0]).toMatchObject({ runId: 11, attemptBase: 1, deferrals: 0 });
    expect(h.retries[0]?.startAfter?.getTime()).toBe(NOW + 15_000);
    expect(h.invalidated).toEqual([]);
  });

  it("goes dead once the retry limit is spent", async () => {
    const h = harness(async () => {
      throw new Error("still broken");
    });
    const report = await executeJob(h.deps, pricesJob(0, { attemptBase: 4, runId: 11 }));
    expect(report).toMatchObject({ outcome: "dead", attempt: 5 });
    expect(h.retries).toHaveLength(0);
    expect(h.counts["jobs.dead"]).toBe(1);
    expect(h.roots[0]).toMatchObject({ status: "failed" });
    expect(h.invalidated).toEqual(["prices"]);
  });

  it("goes dead immediately on non-retryable errors", async () => {
    const h = harness(async () => {
      throw new NonRetryableError("bad data");
    });
    expect((await executeJob(h.deps, pricesJob())).outcome).toBe("dead");
    expect(h.retries).toHaveLength(0);
  });

  it("defers budget exhaustion without spending an attempt", async () => {
    const resumeAt = new Date(NOW + 3_600_000);
    const h = harness(async () => {
      throw new DeferredError(resumeAt, "quota");
    });
    const report = await executeJob(h.deps, pricesJob(0, { attemptBase: 2 }));
    expect(report.outcome).toBe("deferred");
    expect(h.retries[0]).toMatchObject({ attemptBase: 2, deferrals: 1, startAfter: resumeAt });
  });

  it("maps llm budget errors to the next UTC day", async () => {
    const h = harness(async () => {
      throw new AppError("budget", "llm_budget_exceeded");
    });
    await executeJob(h.deps, pricesJob());
    expect(h.retries[0]?.startAfter?.toISOString()).toBe("2026-03-16T00:00:00.000Z");
  });

  it("refuses to run when fenced out of the lease", async () => {
    let called = false;
    const h = harness(
      async () => {
        called = true;
        return { metrics: {} };
      },
      { started: null },
    );
    await expect(executeJob(h.deps, pricesJob())).rejects.toBeInstanceOf(LeaseLostError);
    expect(called).toBe(false);
  });

  it("marks the attempt abandoned when the worker is stopping", async () => {
    const controller = new AbortController();
    const h = harness(
      () =>
        new Promise(() => {
          controller.abort();
        }),
      { stop: controller.signal },
    );
    await expect(executeJob(h.deps, pricesJob())).rejects.toBeInstanceOf(WorkerStoppingError);
    expect(h.finished[0]?.outcome).toBe("abandoned");
    expect(h.retries).toHaveLength(0);
  });

  it("drops invalid envelopes and counts them dead", async () => {
    const h = harness(async () => ({ metrics: {} }));
    const report = await executeJob(h.deps, { id: "x", retryCount: 0, data: { type: "nope" } });
    expect(report.outcome).toBe("invalid");
    expect(h.counts["jobs.dead"]).toBe(1);
    expect(h.finished).toHaveLength(0);
  });
});
