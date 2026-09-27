import type { Logger } from "@ma/core";
import { Lru } from "./lru.js";
import type { RedisClient } from "./redis.js";

export interface CachePolicy {
  ttlMs: number;
  staleMs?: number;
  negativeTtlMs?: number;
}

interface Entry<T> {
  v: T | null;
  f: number;
  s: number;
}

export type CacheOutcome =
  | "hit_l1"
  | "hit_l2"
  | "stale"
  | "miss"
  | "coalesced"
  | "negative"
  | "error";

export interface CacheOptions {
  namespace: string;
  version: number;
  l1Max?: number;
  l1MaxAgeMs?: number;
  logger?: Logger;
}

const now = () => Date.now();

export class Cache {
  private readonly l1: Lru<Entry<unknown>>;
  private readonly inflight = new Map<string, Promise<unknown>>();
  private readonly prefix: string;
  private readonly metricsKey: string;
  private readonly l1MaxAgeMs: number;

  constructor(
    private readonly redis: RedisClient,
    private readonly opts: CacheOptions,
  ) {
    this.l1 = new Lru(opts.l1Max ?? 5_000);
    this.prefix = `${opts.namespace}:v${opts.version}:`;
    this.metricsKey = `metrics:cache:${opts.namespace}`;
    this.l1MaxAgeMs = opts.l1MaxAgeMs ?? 5_000;
  }

  async getOrLoad<T>(
    key: string,
    loader: () => Promise<T | null>,
    policy: CachePolicy,
  ): Promise<T | null> {
    const full = this.prefix + key;
    const t = now();

    const l1 = this.l1.get(full) as Entry<T> | undefined;
    if (l1 && l1.f > t) return this.record("hit_l1", l1.v);

    const l2 = await this.readL2<T>(full);
    if (l2) {
      if (l2.f > t) {
        this.l1.set(full, { ...l2, f: Math.min(l2.f, t + this.l1MaxAgeMs) });
        return this.record(l2.v === null ? "negative" : "hit_l2", l2.v);
      }
      if (l2.s > t) {
        void this.revalidate(full, loader, policy);
        return this.record("stale", l2.v);
      }
    }

    const pending = this.inflight.get(full) as Promise<T | null> | undefined;
    if (pending) return this.record("coalesced", await pending);

    const run = this.load(full, loader, policy);
    this.inflight.set(full, run);
    try {
      return this.record("miss", await run);
    } finally {
      this.inflight.delete(full);
    }
  }

  async invalidate(key: string): Promise<void> {
    const full = this.prefix + key;
    this.l1.delete(full);
    await this.redis.unlink(full);
  }

  async invalidatePrefix(keyPrefix: string): Promise<number> {
    const full = this.prefix + keyPrefix;
    this.l1.deletePrefix(full);
    let cursor = "0";
    let removed = 0;
    do {
      const [next, keys] = await this.redis.scan(cursor, "MATCH", `${full}*`, "COUNT", 500);
      cursor = next;
      if (keys.length) removed += await this.redis.unlink(...keys);
    } while (cursor !== "0");
    return removed;
  }

  async metrics(): Promise<Record<CacheOutcome, number> & { l1Size: number }> {
    const raw = await this.redis.hgetall(this.metricsKey);
    const out = {
      hit_l1: 0,
      hit_l2: 0,
      stale: 0,
      miss: 0,
      coalesced: 0,
      negative: 0,
      error: 0,
      l1Size: this.l1.size,
    };
    for (const [k, v] of Object.entries(raw)) if (k in out) out[k as CacheOutcome] = Number(v);
    return out;
  }

  private async load<T>(
    full: string,
    loader: () => Promise<T | null>,
    policy: CachePolicy,
  ): Promise<T | null> {
    let value: T | null;
    try {
      value = await loader();
    } catch (err) {
      void this.bump("error");
      throw err;
    }
    const t = now();
    const ttl = value === null ? (policy.negativeTtlMs ?? 0) : policy.ttlMs;
    if (ttl <= 0) return value;
    const entry: Entry<T> = {
      v: value,
      f: t + ttl,
      s: t + ttl + (value === null ? 0 : (policy.staleMs ?? 0)),
    };
    this.l1.set(full, { ...entry, f: Math.min(entry.f, t + this.l1MaxAgeMs) });
    await this.redis.set(full, JSON.stringify(entry), "PX", entry.s - t);
    return value;
  }

  private async revalidate<T>(
    full: string,
    loader: () => Promise<T | null>,
    policy: CachePolicy,
  ): Promise<void> {
    const lock = `${full}:lock`;
    const acquired = await this.redis.set(lock, "1", "PX", 30_000, "NX");
    if (!acquired) return;
    try {
      await this.load(full, loader, policy);
    } catch (err) {
      this.opts.logger?.warn({ err, key: full }, "cache revalidate failed");
    } finally {
      await this.redis.unlink(lock);
    }
  }

  private async readL2<T>(full: string): Promise<Entry<T> | null> {
    try {
      const raw = await this.redis.get(full);
      return raw ? (JSON.parse(raw) as Entry<T>) : null;
    } catch (err) {
      this.opts.logger?.warn({ err, key: full }, "cache l2 read failed");
      return null;
    }
  }

  private record<T>(outcome: CacheOutcome, value: T): T {
    void this.bump(outcome);
    return value;
  }

  private async bump(outcome: CacheOutcome): Promise<void> {
    try {
      await this.redis.hincrby(this.metricsKey, outcome, 1);
    } catch {
      /* metrics are best effort */
    }
  }
}
