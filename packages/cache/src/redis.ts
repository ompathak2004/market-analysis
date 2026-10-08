import { Redis } from "ioredis";

export type RedisClient = Redis;

export function createRedis(url: string): RedisClient {
  return new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 2,
    enableAutoPipelining: true,
    connectTimeout: 5_000,
    ...(url.startsWith("rediss://") ? { tls: {} } : {}),
  });
}
