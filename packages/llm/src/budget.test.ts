import { createRedis, type RedisClient } from "@ma/cache";
import { DeadlineExceededError, withDeadline } from "@ma/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LlmBudget } from "./budget.js";
import { LlmBudgetExceeded } from "./errors.js";

const url = process.env.REDIS_URL ?? "redis://localhost:6379";
let redis: RedisClient;

beforeAll(async () => {
  redis = createRedis(url);
  await redis.select(9);
});
beforeEach(async () => {
  await redis.del(LlmBudget.key(), "ratelimit:api.cerebras.ai");
});
afterAll(async () => {
  await redis.quit();
});

const budget = (dailyTokens: number) => new LlmBudget(redis, { rpm: 1_000, dailyTokens });

describe("LlmBudget", () => {
  it("never lets concurrent reservations exceed the daily cap", async () => {
    const b = budget(10_000);
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => b.reserve(3_000)));
    const granted = results.filter((r) => r.status === "fulfilled").length;
    expect(granted).toBe(3);
    expect(
      results
        .filter((r) => r.status === "rejected")
        .every((r) => r.reason instanceof LlmBudgetExceeded),
    ).toBe(true);
    expect(await b.usedToday()).toBe(9_000);
  });

  it("settles a reservation to the actual usage and refunds failed attempts", async () => {
    const b = budget(10_000);
    const used = await b.reserve(4_000);
    const failed = await b.reserve(4_000);
    expect(await b.settle(used, 1_250)).toBe(5_250);
    expect(await b.settle(failed, 0)).toBe(1_250);
    expect(await b.remainingToday()).toBe(8_750);
  });

  it("refuses new work once the cap is reached", async () => {
    const b = budget(1_000);
    await b.reserve(1_000);
    await expect(b.reserve(1)).rejects.toBeInstanceOf(LlmBudgetExceeded);
  });

  it("does not start an attempt that cannot finish before the job deadline", async () => {
    const b = budget(10_000);
    await expect(withDeadline(Date.now() + 10_000, () => b.reserve(100))).rejects.toBeInstanceOf(
      DeadlineExceededError,
    );
    expect(await b.usedToday()).toBe(0);
  });
});
