import { createRedis, type RedisClient } from "@ma/cache";
import { DeadlineExceededError, withDeadline } from "@ma/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LLM_BUDGET_CLASSES, LlmBudget, type LlmBudgetClass } from "./budget.js";
import { LlmBudgetExceeded } from "./errors.js";

const url = process.env.REDIS_URL ?? "redis://localhost:6379";
let redis: RedisClient;

beforeAll(async () => {
  redis = createRedis(url);
  await redis.select(9);
});
beforeEach(async () => {
  const classes = Object.keys(LLM_BUDGET_CLASSES) as LlmBudgetClass[];
  await redis.del(
    LlmBudget.key(),
    ...classes.map((c) => LlmBudget.classKey(c)),
    "ratelimit:api.cerebras.ai",
  );
});
afterAll(async () => {
  await redis.quit();
});

const budget = (dailyTokens: number, classTokens: Partial<Record<LlmBudgetClass, number>> = {}) =>
  new LlmBudget(redis, { rpm: 1_000, dailyTokens, classTokens });

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

  it("isolates each class against its own cap", async () => {
    const b = budget(10_000, { relationships: 2_000 });
    await b.reserve(2_000, "relationships");
    const refused = await b.reserve(1, "relationships").catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(LlmBudgetExceeded);
    expect((refused as LlmBudgetExceeded).details).toEqual({
      used: 2_000,
      budget: 2_000,
      budgetClass: "relationships",
    });
    await expect(b.reserve(3_000, "insights")).resolves.toMatchObject({ tokens: 3_000 });
    expect(await b.usedToday("relationships")).toBe(2_000);
    expect(await b.usedToday("insights")).toBe(3_000);
    expect(await b.usedToday()).toBe(5_000);
    expect(await b.remainingToday("relationships")).toBe(0);
    expect(await b.remainingToday("insights")).toBe(5_000);
  });

  it("enforces the shared daily cap across classes", async () => {
    const b = budget(5_000, { relationships: 4_000, insights: 4_000 });
    await b.reserve(3_000, "relationships");
    const refused = await b.reserve(2_500, "insights").catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(LlmBudgetExceeded);
    expect((refused as LlmBudgetExceeded).details).toMatchObject({ budgetClass: "total" });
    expect(await b.usedToday("insights")).toBe(0);
    expect(await b.usedToday()).toBe(3_000);
  });

  it("settles both the class and the total counters", async () => {
    const b = budget(10_000);
    const r = await b.reserve(1_000, "influence");
    expect(await b.settle(r, 400)).toBe(400);
    expect(await b.usedToday("influence")).toBe(400);
  });

  it("defaults class caps to the configured split bounded by the daily cap", () => {
    expect(budget(800_000).capOf("relationships")).toBe(200_000);
    expect(budget(800_000).capOf("insights")).toBe(500_000);
    expect(budget(50_000).capOf("insights")).toBe(50_000);
    expect(budget(800_000, { influence: 150_000 }).capOf("influence")).toBe(150_000);
  });
});
