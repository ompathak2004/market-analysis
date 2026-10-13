import { beforeEach, describe, expect, it, vi } from "vitest";

const base = {
  DATABASE_URL: "postgres://u:p@localhost:5432/db",
  REDIS_URL: "redis://localhost:6379",
  FIRECRAWL_API_KEY: "fc",
  CEREBRAS_API_KEY: "cb",
};

describe("config", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("keeps the web config strict about its API secrets", async () => {
    const { loadConfig } = await import("./config.js");
    expect(() => loadConfig(base)).toThrow(/API_KEY/);
  });

  it("loads the service config without web secrets and drops them when present", async () => {
    const { loadServiceConfig } = await import("./config.js");
    const config = loadServiceConfig({ ...base, API_KEY: "x".repeat(20) });
    expect(config.DATABASE_URL).toBe(base.DATABASE_URL);
    expect("API_KEY" in config).toBe(false);
  });
});
