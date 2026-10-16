import { Cache, createRedis } from "@ma/cache";
import { type Config, createLogger, loadConfig } from "@ma/core";
import { createDb } from "@ma/db";
import { createIngestContext, type IngestContext } from "@ma/ingest";
import { API_CACHE } from "@ma/jobs";

export interface AppContext extends IngestContext {
  config: Config;
  api: Cache;
}

const WEB_POOL_MAX = 1;
const WEB_STATEMENT_TIMEOUT_MS = 5_000;

export function createAppContext(name: string, config: Config = loadConfig()): AppContext {
  const logger = createLogger(name, config.LOG_LEVEL);
  const db = createDb(config.DATABASE_URL, WEB_POOL_MAX, {
    applicationName: name,
    statementTimeoutMs: WEB_STATEMENT_TIMEOUT_MS,
  });
  const redis = createRedis(config.REDIS_URL);
  const ingest = createIngestContext({ db, redis, config, logger });
  return { ...ingest, config, api: new Cache(redis, { ...API_CACHE, logger }) };
}

const g = globalThis as { __maContext?: AppContext };

export function getContext(): AppContext {
  g.__maContext ??= createAppContext("web");
  return g.__maContext;
}
