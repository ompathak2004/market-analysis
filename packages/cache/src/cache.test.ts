import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Cache } from "./cache.js";
import { createRedis, type RedisClient } from "./redis.js";

const url = process.env.REDIS_URL ?? "redis://localhost:6379";
let redis: RedisClient;

beforeAll(async () => {
  redis = createRedis(url);
  await redis.flushdb();
});
afterAll(async () => {
  await redis.quit();
});

describe("Cache", () => {
  it("coalesces concurrent misses into one load", async () => {
    const cache = new Cache(redis, { namespace: "t1", version: 1 });
    let loads = 0;
    const loader = async () => {
      loads++;
      await new Promise((r) => setTimeout(r, 20));
      return { n: loads };
    };
    const results = await Promise.all(
      [1, 2, 3].map(() => cache.getOrLoad("k", loader, { ttlMs: 1000 })),
    );
    expect(loads).toBe(1);
    expect(results.every((r) => r?.n === 1)).toBe(true);
    const m = await cache.metrics();
    expect(m.miss).toBe(1);
    expect(m.coalesced).toBe(2);
  });

  it("serves from l2 after l1 expiry and serves stale then revalidates", async () => {
    const cache = new Cache(redis, { namespace: "t2", version: 1, l1MaxAgeMs: 1 });
    let calls = 0;
    const loader = async () => ({ calls: ++calls });
    const opts = { ttlMs: 150, staleMs: 5000 };
    await cache.getOrLoad("k", loader, opts);
    await sleep(5);
    expect(await cache.getOrLoad("k", loader, opts)).toEqual({ calls: 1 });
    await sleep(200);
    expect(await cache.getOrLoad("k", loader, opts)).toEqual({ calls: 1 });
    await waitFor(() => calls === 2);
    expect(await cache.getOrLoad("k", loader, opts)).toEqual({ calls: 2 });
    const m = await cache.metrics();
    expect(m.stale).toBe(1);
    expect(m.hit_l2).toBeGreaterThanOrEqual(1);
  });

  it("caches negative results briefly", async () => {
    const cache = new Cache(redis, { namespace: "t3", version: 1 });
    let calls = 0;
    const loader = async () => {
      calls++;
      return null;
    };
    await cache.getOrLoad("missing", loader, { ttlMs: 1000, negativeTtlMs: 200 });
    await cache.getOrLoad("missing", loader, { ttlMs: 1000, negativeTtlMs: 200 });
    expect(calls).toBe(1);
  });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await sleep(10);
  }
}
