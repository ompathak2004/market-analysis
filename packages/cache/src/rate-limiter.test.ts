import { DeadlineExceededError, withDeadline } from "@ma/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RateLimiter } from "./rate-limiter.js";
import { createRedis, type RedisClient } from "./redis.js";

const url = process.env.REDIS_URL ?? "redis://localhost:6379";
let redis: RedisClient;

beforeAll(async () => {
  redis = createRedis(url);
  await redis.select(9);
  await redis.del("ratelimit:rl-test", "ratelimit:rl-ip:a", "ratelimit:rl-ip:b");
});
afterAll(async () => {
  await redis.quit();
});

describe("RateLimiter", () => {
  it("keeps independent buckets per subject", async () => {
    const limiter = new RateLimiter(redis, { "rl-ip": { capacity: 2, perMs: 60_000 } });
    expect(await limiter.tryAcquire("rl-ip", "a")).toBe(0);
    expect(await limiter.tryAcquire("rl-ip", "a")).toBe(0);
    expect(await limiter.tryAcquire("rl-ip", "a")).toBeGreaterThan(0);
    expect(await limiter.tryAcquire("rl-ip", "b")).toBe(0);
  });

  it("refuses to wait past the ambient deadline", async () => {
    const limiter = new RateLimiter(redis, { "rl-test": { capacity: 1, perMs: 10_000 } }, 60_000);
    await limiter.acquire("rl-test");
    const started = Date.now();
    await expect(
      withDeadline(Date.now() + 1_000, () => limiter.acquire("rl-test")),
    ).rejects.toBeInstanceOf(DeadlineExceededError);
    expect(Date.now() - started).toBeLessThan(500);
  });
});
