import { timingSafeEqual } from "node:crypto";
import { RateLimiter } from "@ma/cache";
import { AppError, RateLimitedError } from "@ma/core";
import type { AppContext } from "../context";

export class UnauthorizedError extends AppError {
  constructor(message = "unauthorized") {
    super(message, "UNAUTHORIZED", 401);
  }
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function requireApiKey(ctx: AppContext, req: Request): void {
  const key = req.headers.get("x-api-key");
  if (key && safeEqual(key, ctx.config.API_KEY)) return;
  throw new UnauthorizedError("missing or invalid x-api-key");
}

export function requireCronSecret(ctx: AppContext, req: Request): void {
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token || !safeEqual(token, ctx.config.CRON_SECRET)) {
    throw new UnauthorizedError("missing or invalid cron secret");
  }
}

const PUBLIC_LIMITS = { search: { capacity: 60, perMs: 60_000 } } as const;
const publicLimiters = new WeakMap<AppContext, RateLimiter>();

function clientIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || req.headers.get("x-real-ip") || "unknown";
}

export async function limitPublic(
  ctx: AppContext,
  req: Request,
  bucket: keyof typeof PUBLIC_LIMITS,
): Promise<void> {
  let limiter = publicLimiters.get(ctx);
  if (!limiter) {
    limiter = new RateLimiter(ctx.redis, PUBLIC_LIMITS);
    publicLimiters.set(ctx, limiter);
  }
  const wait = await limiter.tryAcquire(bucket, clientIp(req));
  if (wait > 0) throw new RateLimitedError(bucket, wait);
}
