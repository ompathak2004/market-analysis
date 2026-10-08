import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createRedis, type RedisClient } from "@ma/cache";
import { createLogger, UpstreamError } from "@ma/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Firecrawl } from "./firecrawl.js";
import { FirecrawlBudget, firecrawlMonth } from "./firecrawl-budget.js";

let server: Server;
let base = "";
let redis: RedisClient;
const key = `firecrawl:credits:${firecrawlMonth()}`;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      const { url = "", query = "" } = JSON.parse(body) as { url?: string; query?: string };
      const mode = url || query;
      if (mode.includes("drop")) return req.socket.destroy();
      if (mode.includes("fail")) {
        res.statusCode = 500;
        return res.end(JSON.stringify({ success: false, error: "boom" }));
      }
      res.setHeader("content-type", "application/json");
      if (query) {
        return res.end(
          JSON.stringify({ success: true, data: [{ url: "https://a" }, { url: "https://b" }] }),
        );
      }
      setTimeout(
        () => res.end(JSON.stringify({ success: true, data: { metadata: {} }, creditsUsed: 1 })),
        20,
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  redis = createRedis(process.env.REDIS_URL ?? "redis://localhost:6379");
  await redis.select(9);
});
beforeEach(async () => {
  await redis.del(key);
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await redis.quit();
});

function client(limit: number) {
  const budget = new FirecrawlBudget(redis, limit);
  return { budget, fc: new Firecrawl("k", createLogger("fc-test", "silent"), base, budget) };
}

describe("Firecrawl credit budget", () => {
  it("never lets concurrent requests overspend the monthly cap", async () => {
    const { budget, fc } = client(3);
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) => fc.scrape(`https://ok/${i}`)),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    expect(await budget.used()).toBe(3);
  });

  it("refunds definite upstream errors but keeps ambiguous failures charged", async () => {
    const { budget, fc } = client(10);
    await expect(fc.scrape("https://fail")).rejects.toBeInstanceOf(UpstreamError);
    expect(await budget.used()).toBe(0);
    await expect(fc.scrape("https://drop")).rejects.toThrow();
    expect(await budget.used()).toBe(1);
  });

  it("settles a search to the credits actually spent", async () => {
    const { budget, fc } = client(100);
    const hits = await fc.search("ok", { limit: 10, scrape: true });
    expect(hits).toHaveLength(2);
    expect(await budget.used()).toBe(4);
  });
});
