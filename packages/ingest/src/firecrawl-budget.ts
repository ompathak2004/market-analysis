import type { RedisClient } from "@ma/cache";
import { UpstreamError } from "@ma/core";

const RETAIN_SECONDS = 40 * 24 * 3600;

export const firecrawlMonth = (at = new Date()): string => at.toISOString().slice(0, 7);

export interface FirecrawlCredits {
  month: string;
  used: number;
  limit: number;
  remaining: number;
}

export class FirecrawlBudget {
  constructor(
    private readonly redis: RedisClient,
    private readonly monthlyCredits: number,
  ) {}

  private key(at = new Date()): string {
    return `firecrawl:credits:${firecrawlMonth(at)}`;
  }

  async used(): Promise<number> {
    const raw = await this.redis.get(this.key());
    return raw ? Number(raw) : 0;
  }

  async status(): Promise<FirecrawlCredits> {
    const used = await this.used();
    return {
      month: firecrawlMonth(),
      used,
      limit: this.monthlyCredits,
      remaining: Math.max(0, this.monthlyCredits - used),
    };
  }

  async ensure(credits: number): Promise<void> {
    const used = await this.used();
    if (used + credits > this.monthlyCredits) {
      throw new UpstreamError("firecrawl", "budget exhausted", {
        used,
        limit: this.monthlyCredits,
        requested: credits,
      });
    }
  }

  async consume(credits: number): Promise<number> {
    if (credits <= 0) return this.used();
    const key = this.key();
    const total = await this.redis.incrby(key, Math.ceil(credits));
    await this.redis.expire(key, RETAIN_SECONDS);
    return total;
  }
}
