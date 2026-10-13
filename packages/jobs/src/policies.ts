import { AppError, DAY, MINUTE } from "@ma/core";
import type { Lane } from "./contracts.js";

export const LANE_CONCURRENCY: Record<Lane, number> = {
  control: 1,
  io: 4,
  parse: 1,
  compute: 2,
  llm: 2,
  cache: 1,
};

export const BACKOFF_BASE_MS = 30_000;
export const BACKOFF_MAX_MS = 30 * MINUTE;
export const RETRY_AFTER_MAX_MS = DAY;

export class DeferredError extends AppError {
  constructor(
    readonly resumeAt: Date,
    reason: string,
  ) {
    super(`deferred until ${resumeAt.toISOString()}: ${reason}`, "deferred", 503, { reason });
  }
}

export class NonRetryableError extends AppError {
  constructor(message: string, cause?: unknown) {
    super(message, "non_retryable", 422);
    if (cause !== undefined) this.cause = cause;
  }
}

export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const exp = BACKOFF_BASE_MS * 2 ** Math.max(0, Math.min(16, attempt - 1));
  const jittered = exp / 2 + (exp / 2) * random();
  return Math.round(Math.min(BACKOFF_MAX_MS, jittered));
}

export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000);
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - now);
}

export function retryAfterOf(err: unknown): number | null {
  if (!(err instanceof AppError)) return null;
  const details = err.details ?? {};
  const ms = details.retryAfterMs;
  if (typeof ms === "number" && Number.isFinite(ms) && ms >= 0) return ms;
  const header = details.retryAfter;
  return typeof header === "string" ? parseRetryAfter(header) : null;
}

export function retryDelayMs(
  attempt: number,
  err: unknown,
  random: () => number = Math.random,
): number {
  const hinted = retryAfterOf(err);
  const base = backoffMs(attempt, random);
  return hinted === null ? base : Math.max(base, Math.min(RETRY_AFTER_MAX_MS, hinted));
}

const NON_RETRYABLE_CODES = new Set([
  "non_retryable",
  "llm_invalid_output",
  "llm_prompt_too_large",
  "not_found",
]);

export function isRetryable(err: unknown): boolean {
  if (err instanceof Error && err.name === "ZodError") return false;
  return !(err instanceof AppError && NON_RETRYABLE_CODES.has(err.code));
}

function jitter(maxMs: number, random: () => number): number {
  return Math.round(maxMs * random());
}

export function nextUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}

export function nextUtcMonth(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

export function asDeferred(
  err: unknown,
  now = new Date(),
  random: () => number = Math.random,
): DeferredError | null {
  if (err instanceof DeferredError) return err;
  if (!(err instanceof AppError)) return null;
  if (err.code === "llm_budget_exceeded") {
    const at = new Date(nextUtcDay(now).getTime() + jitter(15 * MINUTE, random));
    return new DeferredError(at, "llm daily token budget exhausted");
  }
  if (
    err.code === "upstream_error" &&
    err.details?.source === "firecrawl" &&
    /budget/.test(err.message)
  ) {
    const at = new Date(nextUtcMonth(now).getTime() + jitter(60 * MINUTE, random));
    return new DeferredError(at, "firecrawl monthly credits exhausted");
  }
  return null;
}
