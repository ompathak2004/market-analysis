import { Redis } from "ioredis";

export type RedisClient = Redis;

export function createRedis(url: string): RedisClient {
  return new Redis(url, {
    maxRetriesPerRequest: 2,
    enableAutoPipelining: true,
    ...(url.startsWith("rediss://") ? { tls: {} } : {}),
  });
}
