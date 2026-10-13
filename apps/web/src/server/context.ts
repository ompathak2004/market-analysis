import { Cache, createRedis } from "@ma/cache";
import { type Config, createLogger, loadConfig } from "@ma/core";
import { createDb, llmUsage } from "@ma/db";
import { createIngestContext, type IngestContext } from "@ma/ingest";
import { createLlmClient, type LlmClient } from "@ma/llm";

export interface AppContext extends IngestContext {
  api: Cache;
  llm: LlmClient;
}

export function createAppContext(name: string, config: Config = loadConfig()): AppContext {
  const logger = createLogger(name, config.LOG_LEVEL);
  const db = createDb(config.DATABASE_URL, 2);
  const redis = createRedis(config.REDIS_URL);
  const ingest = createIngestContext({ db, redis, config, logger });
  const llm = createLlmClient({
    config,
    redis,
    logger,
    record: async (usage) => {
      await db
        .insert(llmUsage)
        .values(usage)
        .catch((err: unknown) => logger.warn({ err }, "llm usage insert failed"));
    },
  });
  return { ...ingest, api: new Cache(redis, { namespace: "api", version: 2, logger }), llm };
}

const g = globalThis as { __maContext?: AppContext };

export function getContext(): AppContext {
  g.__maContext ??= createAppContext("web");
  return g.__maContext;
}
