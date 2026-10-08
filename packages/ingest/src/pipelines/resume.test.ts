import { createRedis, type RedisClient } from "@ma/cache";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { beginPass, endPass, parseResume } from "./resume.js";

const keys = { cursorKey: "test:derive:cursor", resumeKey: "test:derive:resume" };
const T0 = Date.parse("2026-10-08T00:00:00Z");
let redis: RedisClient;

beforeAll(async () => {
  redis = createRedis(process.env.REDIS_URL ?? "redis://localhost:6379");
  await redis.select(9);
});

beforeEach(async () => {
  await redis.del(keys.cursorKey, keys.resumeKey);
});

afterAll(async () => {
  await redis.del(keys.cursorKey, keys.resumeKey);
  await redis.quit();
});

describe("derive passes", () => {
  it("keeps the cursor and resumes after the last id until the pass completes", async () => {
    await redis.set(keys.cursorKey, new Date(T0).toISOString());
    const first = await beginPass(redis, keys, new Date(T0 + 60_000), new Date(0));
    expect(first).toMatchObject({ afterId: 0, resumed: false, cursor: new Date(T0) });
    await endPass(redis, first, { complete: false, lastId: 41 });
    expect(await redis.get(keys.cursorKey)).toBe(new Date(T0).toISOString());

    const second = await beginPass(redis, keys, new Date(T0 + 120_000), new Date(0));
    expect(second).toMatchObject({
      afterId: 41,
      resumed: true,
      cursor: new Date(T0),
      passStart: new Date(T0 + 60_000),
    });
    await endPass(redis, second, { complete: true, lastId: 90 });
    expect(await redis.get(keys.cursorKey)).toBe(new Date(T0 + 60_000).toISOString());
    expect(await redis.get(keys.resumeKey)).toBeNull();

    const third = await beginPass(redis, keys, new Date(T0 + 180_000), new Date(0));
    expect(third).toMatchObject({ afterId: 0, resumed: false, cursor: new Date(T0 + 60_000) });
  });

  it("starts from the initial cursor and ignores malformed resume state", async () => {
    await redis.set(keys.resumeKey, "{not json");
    const pass = await beginPass(redis, keys, new Date(T0), new Date(T0 - 1_000));
    expect(pass).toMatchObject({ afterId: 0, resumed: false, cursor: new Date(T0 - 1_000) });
    expect(parseResume(JSON.stringify({ passStart: "x", afterId: 3 }))).toBeNull();
    expect(
      parseResume(JSON.stringify({ passStart: new Date(T0).toISOString(), afterId: 1.5 })),
    ).toBeNull();
  });
});
