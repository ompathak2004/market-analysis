import { DeadlineExceededError, RateLimitedError, remainingMs, sleep } from "@ma/core";
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
    const wait = await this.take(`ratelimit:${bucket}`, rule);
    if (wait <= 0) return;
    if (wait > this.maxWaitMs) throw new RateLimitedError(bucket, wait);
    const left = remainingMs();
    if (wait > left) throw new DeadlineExceededError(wait, Math.max(0, left));
    await sleep(wait);
    return this.acquire(bucket);
  }

  async tryAcquire(bucket: string, subject: string): Promise<number> {
    const rule = this.rules[bucket];
    if (!rule) return 0;
    return this.take(`ratelimit:${bucket}:${subject}`, rule);
  }

  private take(key: string, rule: RateLimitRule): Promise<number> {
    const client = this.redis as RedisClient & {
      takeToken: (key: string, cap: number, refill: number, now: number) => Promise<number>;
    };
    return client.takeToken(key, rule.capacity, rule.capacity / rule.perMs, Date.now());
  }
}
