import { RateLimiter, type RedisClient } from "@ma/cache";
import { assertTimeLeft, isoDate } from "@ma/core";
import { LlmBudgetExceeded } from "./errors.js";

export const CEREBRAS_HOST = "api.cerebras.ai";
const TOKEN_KEY_TTL_S = 2 * 86_400;
const ATTEMPT_MS = 65_000;

const RESERVE = `
local after = redis.call('INCRBY', KEYS[1], ARGV[1])
redis.call('EXPIRE', KEYS[1], ARGV[3])
local before = after - tonumber(ARGV[1])
if after > tonumber(ARGV[2]) or before >= tonumber(ARGV[2]) then
  redis.call('DECRBY', KEYS[1], ARGV[1])
  return {0, before}
end
return {1, after}
`;

export interface LlmBudgetOptions {
  rpm: number;
  dailyTokens: number;
  maxWaitMs?: number;
  attemptMs?: number;
}

export interface LlmReservation {
  readonly key: string;
  readonly tokens: number;
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

  async reserve(tokens: number): Promise<LlmReservation> {
    const attemptMs = this.opts.attemptMs ?? ATTEMPT_MS;
    assertTimeLeft(attemptMs);
    const key = LlmBudget.key();
    const amount = Math.max(0, Math.round(tokens));
    const [ok, used] = (await this.redis.eval(
      RESERVE,
      1,
      key,
      amount,
      this.opts.dailyTokens,
      TOKEN_KEY_TTL_S,
    )) as [number, number];
    if (!ok) throw new LlmBudgetExceeded(used, this.opts.dailyTokens);
    const reservation = { key, tokens: amount };
    try {
      await this.limiter.acquire(CEREBRAS_HOST);
      assertTimeLeft(attemptMs);
    } catch (err) {
      await this.settle(reservation, 0);
      throw err;
    }
    return reservation;
  }

  async settle(reservation: LlmReservation, actualTokens: number): Promise<number> {
    const delta = Math.max(0, Math.round(actualTokens)) - reservation.tokens;
    if (delta === 0) return Number((await this.redis.get(reservation.key)) ?? 0);
    const total = await this.redis.incrby(reservation.key, delta);
    await this.redis.expire(reservation.key, TOKEN_KEY_TTL_S);
    return total;
  }
}
