import { RateLimitedError, sleep } from "@ma/core";
import type { RedisClient } from "./redis.js";

const TOKEN_BUCKET = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill_per_ms = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local bucket = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(bucket[1])
local ts = tonumber(bucket[2])
if tokens == nil then tokens = capacity; ts = now end
tokens = math.min(capacity, tokens + (now - ts) * refill_per_ms)
local wait = 0
if tokens >= 1 then
  tokens = tokens - 1
else
  wait = math.ceil((1 - tokens) / refill_per_ms)
end
redis.call('HSET', key, 'tokens', tokens, 'ts', now)
redis.call('PEXPIRE', key, math.ceil(capacity / refill_per_ms) + 1000)
return wait
`;

export interface RateLimitRule {
  capacity: number;
  perMs: number;
}

export class RateLimiter {
  constructor(
    private readonly redis: RedisClient,
    private readonly rules: Record<string, RateLimitRule>,
    private readonly maxWaitMs = 30_000,
  ) {
    redis.defineCommand("takeToken", { numberOfKeys: 1, lua: TOKEN_BUCKET });
  }

  async acquire(bucket: string): Promise<void> {
    const rule = this.rules[bucket];
    if (!rule) return;
    const refillPerMs = rule.capacity / rule.perMs;
    const client = this.redis as RedisClient & {
      takeToken: (key: string, cap: number, refill: number, now: number) => Promise<number>;
    };
    const wait = await client.takeToken(
      `ratelimit:${bucket}`,
      rule.capacity,
      refillPerMs,
      Date.now(),
    );
    if (wait <= 0) return;
    if (wait > this.maxWaitMs) throw new RateLimitedError(bucket, wait);
    await sleep(wait);
    return this.acquire(bucket);
  }
}
