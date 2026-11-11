import { createHmac, timingSafeEqual } from "node:crypto";
import { RateLimiter } from "@ma/cache";
import { AppError, RateLimitedError } from "@ma/core";
import type { AppContext } from "../context";

export class UnauthorizedError extends AppError {
  constructor(message = "unauthorized", status: 401 | 404 = 401) {
    super(message, status === 404 ? "not_found" : "UNAUTHORIZED", status);
  }
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function requireApiKey(ctx: AppContext, req: Request): void {
  const key = req.headers.get("x-api-key");
  if (key && safeEqual(key, ctx.config.API_KEY)) return;
  throw new UnauthorizedError("missing or invalid x-api-key");
}

export const ADMIN_COOKIE = "ma_admin";
export const ADMIN_TTL_MS = 12 * 60 * 60 * 1000;
export const ADMIN_REVIEWER = "operator";

interface HeaderSource {
  headers: { get(name: string): string | null };
}

function adminSignature(key: string, expiresAt: number): string {
  return createHmac("sha256", key).update(`${ADMIN_COOKIE}.${expiresAt}`).digest("base64url");
}

export function signAdminCookie(key: string, expiresAtMs: number): string {
  const expiresAt = Math.floor(expiresAtMs);
  return `${expiresAt}.${adminSignature(key, expiresAt)}`;
}

export function verifyAdminCookie(
  key: string,
  value: string | null | undefined,
  now = Date.now(),
): boolean {
  const m = value ? /^(\d{13})\.([A-Za-z0-9_-]{43})$/.exec(value) : null;
  if (!m?.[1] || !m[2]) return false;
  const expiresAt = Number(m[1]);
  if (expiresAt <= now || expiresAt > now + ADMIN_TTL_MS) return false;
  return safeEqual(m[2], adminSignature(key, expiresAt));
}

export function readCookie(header: string | null | undefined, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim() || null;
  }
  return null;
}

export function adminKey(ctx: Pick<AppContext, "config">): string {
  const key = ctx.config.ADMIN_API_KEY;
  if (!key) throw new UnauthorizedError("not found", 404);
  return key;
}

function crossSite(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return false;
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  try {
    return new URL(origin).host !== host;
  } catch {
    return true;
  }
}

export function requireAdmin(
  ctx: Pick<AppContext, "config">,
  req: Request,
  now = Date.now(),
): string {
  const key = adminKey(ctx);
  const header = req.headers.get("x-admin-key");
  if (header && safeEqual(header, key)) return ADMIN_REVIEWER;
  const cookie = readCookie(req.headers.get("cookie"), ADMIN_COOKIE);
  const unsafe = req.method !== "GET" && req.method !== "HEAD";
  if (verifyAdminCookie(key, cookie, now) && !(unsafe && crossSite(req))) return ADMIN_REVIEWER;
  throw new UnauthorizedError("missing or invalid admin credentials");
}

const PUBLIC_LIMITS = {
  search: { capacity: 60, perMs: 60_000 },
  adminLogin: { capacity: 10, perMs: 15 * 60_000 },
  bot: { capacity: 12, perMs: 10 * 60_000 },
  botRead: { capacity: 120, perMs: 60_000 },
  botDaily: { capacity: 20, perMs: 24 * 60 * 60_000 },
} as const;
const publicLimiters = new WeakMap<AppContext, RateLimiter>();

export function rateSubject(ip: string): string {
  return ip.includes(":") ? `${ip.split(":").slice(0, 4).join(":")}::/64` : ip;
}

export function clientIp(req: HeaderSource): string {
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || req.headers.get("x-real-ip") || "unknown";
}

export async function limitPublic(
  ctx: AppContext,
  req: HeaderSource,
  bucket: keyof typeof PUBLIC_LIMITS,
  subject: string = clientIp(req),
): Promise<void> {
  let limiter = publicLimiters.get(ctx);
  if (!limiter) {
    limiter = new RateLimiter(ctx.redis, PUBLIC_LIMITS);
    publicLimiters.set(ctx, limiter);
  }
  const wait = await limiter.tryAcquire(bucket, subject);
  if (wait > 0) throw new RateLimitedError(bucket, wait);
}
