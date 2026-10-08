import { timingSafeEqual } from "node:crypto";
import { AppError } from "@ma/core";
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

export function requireApiKey(
  ctx: AppContext,
  req: Request,
  opts: { allowSameOrigin?: boolean } = {},
): void {
  const key = req.headers.get("x-api-key");
  if (key && safeEqual(key, ctx.config.API_KEY)) return;
  if (opts.allowSameOrigin && req.headers.get("sec-fetch-site") === "same-origin") return;
  throw new UnauthorizedError("missing or invalid x-api-key");
}

export function requireCronSecret(ctx: AppContext, req: Request): void {
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token || !safeEqual(token, ctx.config.CRON_SECRET)) {
    throw new UnauthorizedError("missing or invalid cron secret");
  }
}
