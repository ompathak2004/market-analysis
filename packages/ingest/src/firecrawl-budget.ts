import type { RedisClient } from "@ma/cache";
import { UpstreamError } from "@ma/core";

const RETAIN_SECONDS = 40 * 24 * 3600;

const RESERVE = `
local after = redis.call('INCRBY', KEYS[1], ARGV[1])
redis.call('EXPIRE', KEYS[1], ARGV[3])
if after > tonumber(ARGV[2]) then
  redis.call('DECRBY', KEYS[1], ARGV[1])
  return {0, after - tonumber(ARGV[1])}
end
return {1, after}
`;

export const firecrawlMonth = (at = new Date()): string => at.toISOString().slice(0, 7);

export interface FirecrawlCredits {
  month: string;
  used: number;
  limit: number;
  remaining: number;
}

export interface FirecrawlReservation {
  readonly key: string;
  readonly credits: number;
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

  async reserve(credits: number): Promise<FirecrawlReservation> {
    const key = this.key();
    const amount = Math.max(1, Math.ceil(credits));
    const [ok, used] = (await this.redis.eval(
      RESERVE,
      1,
      key,
      amount,
      this.monthlyCredits,
      RETAIN_SECONDS,
    )) as [number, number];
    if (!ok) {
      throw new UpstreamError("firecrawl", "budget exhausted", {
        used,
        limit: this.monthlyCredits,
        requested: amount,
      });
    }
    return { key, credits: amount };
  }

  async settle(reservation: FirecrawlReservation, actualCredits: number): Promise<number> {
    const delta = Math.max(0, Math.ceil(actualCredits)) - reservation.credits;
    if (delta === 0) return Number((await this.redis.get(reservation.key)) ?? 0);
    const total = await this.redis.incrby(reservation.key, delta);
    await this.redis.expire(reservation.key, RETAIN_SECONDS);
    return total;
  }
}
