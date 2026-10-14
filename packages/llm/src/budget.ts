import { RateLimiter, type RedisClient } from "@ma/cache";
import { assertTimeLeft, isoDate } from "@ma/core";
import { LlmBudgetExceeded } from "./errors.js";

export const CEREBRAS_HOST = "api.cerebras.ai";
const TOKEN_KEY_TTL_S = 2 * 86_400;
const ATTEMPT_MS = 65_000;

export type LlmBudgetClass = "relationships" | "insights" | "influence";

export const LLM_BUDGET_CLASSES: Readonly<Record<LlmBudgetClass, number>> = {
  relationships: 200_000,
  insights: 500_000,
  influence: 100_000,
};

const RESERVE = `
local amount = tonumber(ARGV[1])
local classCap = tonumber(ARGV[2])
local totalCap = tonumber(ARGV[3])
local classAfter = redis.call('INCRBY', KEYS[1], amount)
local totalAfter = redis.call('INCRBY', KEYS[2], amount)
redis.call('EXPIRE', KEYS[1], ARGV[4])
redis.call('EXPIRE', KEYS[2], ARGV[4])
local classBefore = classAfter - amount
local totalBefore = totalAfter - amount
local refused = 0
if classAfter > classCap or classBefore >= classCap then
  refused = 1
elseif totalAfter > totalCap or totalBefore >= totalCap then
  refused = 2
end
if refused > 0 then
  redis.call('DECRBY', KEYS[1], amount)
  redis.call('DECRBY', KEYS[2], amount)
  return {refused, classBefore, totalBefore}
end
return {0, classAfter, totalAfter}
`;

export interface LlmBudgetOptions {
  rpm: number;
  dailyTokens: number;
  classTokens?: Partial<Record<LlmBudgetClass, number>>;
  maxWaitMs?: number;
  attemptMs?: number;
}

export interface LlmReservation {
  readonly key: string;
  readonly classKey: string;
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
    return `llm:tokens:{${isoDate(day)}}`;
  }

  static classKey(cls: LlmBudgetClass, day = new Date()): string {
    return `${LlmBudget.key(day)}:${cls}`;
  }

  capOf(cls: LlmBudgetClass): number {
    return Math.min(this.opts.dailyTokens, this.opts.classTokens?.[cls] ?? LLM_BUDGET_CLASSES[cls]);
  }

  async usedToday(cls?: LlmBudgetClass): Promise<number> {
    const key = cls ? LlmBudget.classKey(cls) : LlmBudget.key();
    return Number((await this.redis.get(key)) ?? 0);
  }

  async remainingToday(cls?: LlmBudgetClass): Promise<number> {
    const total = Math.max(0, this.opts.dailyTokens - (await this.usedToday()));
    if (!cls) return total;
    return Math.min(total, Math.max(0, this.capOf(cls) - (await this.usedToday(cls))));
  }

  async reserve(tokens: number, cls: LlmBudgetClass = "insights"): Promise<LlmReservation> {
    const attemptMs = this.opts.attemptMs ?? ATTEMPT_MS;
    assertTimeLeft(attemptMs);
    const day = new Date();
    const key = LlmBudget.key(day);
    const classKey = LlmBudget.classKey(cls, day);
    const amount = Math.max(0, Math.round(tokens));
    const classCap = this.capOf(cls);
    const [refused, classUsed, totalUsed] = (await this.redis.eval(
      RESERVE,
      2,
      classKey,
      key,
      amount,
      classCap,
      this.opts.dailyTokens,
      TOKEN_KEY_TTL_S,
    )) as [number, number, number];
    if (refused === 1) throw new LlmBudgetExceeded(classUsed, classCap, cls);
    if (refused === 2) throw new LlmBudgetExceeded(totalUsed, this.opts.dailyTokens, "total");
    const reservation = { key, classKey, tokens: amount };
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
    await this.redis.incrby(reservation.classKey, delta);
    await this.redis.expire(reservation.classKey, TOKEN_KEY_TTL_S);
    const total = await this.redis.incrby(reservation.key, delta);
    await this.redis.expire(reservation.key, TOKEN_KEY_TTL_S);
    return total;
  }
}
