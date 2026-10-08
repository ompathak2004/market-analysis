import { Cache, createRedis } from "@ma/cache";
import { type Config, createLogger, loadConfig } from "@ma/core";
import { createDb } from "@ma/db";
import { createIngestContext, type IngestContext } from "@ma/ingest";

export interface AppContext extends IngestContext {
  api: Cache;
}

export function createAppContext(name: string, config: Config = loadConfig()): AppContext {
  const logger = createLogger(name, config.LOG_LEVEL);
  const db = createDb(config.DATABASE_URL, 3);
  const redis = createRedis(config.REDIS_URL);
  const ingest = createIngestContext({ db, redis, config, logger });
  return { ...ingest, api: new Cache(redis, { namespace: "api", version: 2, logger }) };
}

const g = globalThis as { __maContext?: AppContext };

export function getContext(): AppContext {
  g.__maContext ??= createAppContext("web");
  return g.__maContext;
}
