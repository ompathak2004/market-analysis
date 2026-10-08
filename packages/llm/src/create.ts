import type { RedisClient } from "@ma/cache";
import type { Config, Logger } from "@ma/core";
import { LlmBudget } from "./budget.js";
import { LlmClient, type LlmUsage } from "./client.js";

export function createLlmClient(deps: {
  config: Config;
  redis: RedisClient;
  logger: Logger;
  record?: (usage: LlmUsage) => Promise<void> | void;
}): LlmClient {
  const { config, redis, logger, record } = deps;
  return new LlmClient({
    apiKey: config.CEREBRAS_API_KEY,
    model: config.CEREBRAS_MODEL,
    fallbackModel: config.CEREBRAS_FALLBACK_MODEL,
    logger: logger.child({ component: "llm" }),
    budget: new LlmBudget(redis, {
      rpm: config.CEREBRAS_RPM,
      dailyTokens: config.LLM_DAILY_TOKEN_BUDGET,
    }),
    ...(record ? { record } : {}),
  });
}
