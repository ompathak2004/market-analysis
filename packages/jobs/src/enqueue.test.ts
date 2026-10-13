import { describe, expect, it } from "vitest";
import { enqueue, expireSeconds, type QueueClient, sendOptions } from "./enqueue.js";

function fakeBoss(result: string | null = "job-1") {
  const calls: { name: string; data: unknown; options: unknown }[] = [];
  const boss = {
    send: async (name: string, data: unknown, options: unknown) => {
      calls.push({ name, data, options });
      return result;
    },
  } as unknown as QueueClient;
  return { boss, calls };
}

describe("enqueue", () => {
  it("sends a validated envelope to the job's lane keyed by unit", async () => {
    const { boss, calls } = fakeBoss();
    const result = await enqueue(boss, { type: "prices.sync", payload: { companyId: 9 } });
    expect(result).toEqual({ jobId: "job-1", runId: null, unitKey: "prices.sync:9" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe("io");
    expect(calls[0]?.data).toEqual({
      type: "prices.sync",
      payload: { companyId: 9 },
      campaignId: null,
      runId: null,
      attemptBase: 0,
      deferrals: 0,
    });
    expect(calls[0]?.options).toMatchObject({
      singletonKey: "prices.sync:9",
      expireInSeconds: expireSeconds("prices.sync"),
    });
  });

  it("carries run id and retry budget on re-sends", async () => {
    const { boss, calls } = fakeBoss();
    const startAfter = new Date("2026-01-01T00:00:00Z");
    await enqueue(boss, {
      type: "prices.sync",
      payload: { companyId: 9 },
      runId: 42,
      attemptBase: 3,
      deferrals: 1,
      startAfter,
    });
    expect(calls[0]?.data).toMatchObject({ runId: 42, attemptBase: 3, deferrals: 1 });
    expect(calls[0]?.options).toMatchObject({ retryLimit: 1, startAfter });
  });

  it("records the priority in the envelope so a retry can re-send it", async () => {
    const { boss, calls } = fakeBoss();
    await enqueue(boss, { type: "prices.sync", payload: { companyId: 9 }, priority: 3 });
    expect(calls[0]?.data).toMatchObject({ priority: 3 });
    expect(calls[0]?.options).toMatchObject({ priority: 3 });
  });

  it("rejects invalid payloads before sending", async () => {
    const { boss, calls } = fakeBoss();
    await expect(
      enqueue(boss, { type: "prices.sync", payload: { companyId: "x" } as never }),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("never sends a negative retry limit", () => {
    expect(sendOptions("prices.sync", "k", { attemptBase: 99 }).retryLimit).toBe(0);
  });
});
