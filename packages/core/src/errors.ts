export class AppError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status = 500,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class NotFoundError extends AppError {
  constructor(entity: string, key: string) {
    super(`${entity} not found: ${key}`, "not_found", 404, { entity, key });
  }
}

export class UpstreamError extends AppError {
  constructor(source: string, message: string, details?: Record<string, unknown>) {
    super(`${source}: ${message}`, "upstream_error", 502, { source, ...details });
  }
}

export class RateLimitedError extends AppError {
  constructor(source: string, retryAfterMs: number) {
    super(`${source} rate limited`, "rate_limited", 429, { source, retryAfterMs });
  }
}
