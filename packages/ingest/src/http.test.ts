import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { RateLimiter } from "@ma/cache";
import { createLogger, DeadlineExceededError, UpstreamError, withDeadline } from "@ma/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HttpClient } from "./http.js";

let server: Server;
let base = "";
let hits = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    hits++;
    if (req.url === "/slow") {
      setTimeout(() => res.end("late"), 5_000).unref();
      return;
    }
    res.statusCode = 503;
    res.setHeader("retry-after", "3");
    res.end("busy");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

const limiter = { acquire: async () => undefined } as unknown as RateLimiter;
const http = new HttpClient(limiter, createLogger("http-test", "silent"));

describe("HttpClient deadlines", () => {
  it("cuts a request off at the ambient deadline", async () => {
    const started = Date.now();
    await expect(
      withDeadline(Date.now() + 1_300, () => http.get(`${base}/slow`, { timeoutMs: 30_000 })),
    ).rejects.toBeInstanceOf(UpstreamError);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("does not sleep into a retry it cannot finish", async () => {
    hits = 0;
    const started = Date.now();
    await expect(
      withDeadline(Date.now() + 2_000, () => http.get(`${base}/busy`, { retries: 3 })),
    ).rejects.toBeInstanceOf(UpstreamError);
    expect(hits).toBe(1);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("refuses to start once the deadline is too close", async () => {
    await expect(
      withDeadline(Date.now() + 200, () => http.get(`${base}/busy`)),
    ).rejects.toBeInstanceOf(DeadlineExceededError);
  });
});
