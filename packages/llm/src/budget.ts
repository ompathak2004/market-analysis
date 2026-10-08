import { RateLimiter, type RedisClient } from "@ma/cache";
import { isoDate } from "@ma/core";
import { LlmBudgetExceeded } from "./errors.js";

export const CEREBRAS_HOST = "api.cerebras.ai";
const TOKEN_KEY_TTL_S = 2 * 86_400;

export interface LlmBudgetOptions {
  rpm: number;
  dailyTokens: number;
  maxWaitMs?: number;
}

export class LlmBudget {
  private readonly limiter: RateLimiter;

  constructor(
    private readonly redis: RedisClient,
    private readonly opts: LlmBudgetOptions,
  ) {
    this.limiter = new RateLimiter(
      redis,
      { [CEREBRAS_HOST]: { capacity: opts.rpm, perMs: 60_000 } },
      opts.maxWaitMs ?? 65_000,
    );
  }

  static key(day = new Date()): string {
    return `llm:tokens:${isoDate(day)}`;
  }

  async usedToday(): Promise<number> {
    return Number((await this.redis.get(LlmBudget.key())) ?? 0);
  }

  async remainingToday(): Promise<number> {
    return Math.max(0, this.opts.dailyTokens - (await this.usedToday()));
  }

  async acquire(): Promise<void> {
    const used = await this.usedToday();
    if (used >= this.opts.dailyTokens) throw new LlmBudgetExceeded(used, this.opts.dailyTokens);
    await this.limiter.acquire(CEREBRAS_HOST);
  }

  async consume(tokens: number): Promise<number> {
    if (tokens <= 0) return this.usedToday();
    const key = LlmBudget.key();
    const total = await this.redis.incrby(key, Math.round(tokens));
    await this.redis.expire(key, TOKEN_KEY_TTL_S);
    return total;
  }
}
