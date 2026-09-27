import { Cache, createRedis } from "@ma/cache";
import { type Config, createLogger, loadConfig } from "@ma/core";
import { closeDb, createDb } from "@ma/db";
import { createIngestContext, type IngestContext } from "@ma/ingest";

export interface AppContext extends IngestContext {
  api: Cache;
}

export function createAppContext(name: string, config: Config = loadConfig()): AppContext {
  const logger = createLogger(name, config.LOG_LEVEL);
  const db = createDb(config.DATABASE_URL, 10);
  const redis = createRedis(config.REDIS_URL);
  const ingest = createIngestContext({ db, redis, config, logger });
  return { ...ingest, api: new Cache(redis, { namespace: "api", version: 1, logger }) };
}

export async function closeAppContext(ctx: AppContext): Promise<void> {
  await closeDb(ctx.db);
  ctx.redis.disconnect();
}
