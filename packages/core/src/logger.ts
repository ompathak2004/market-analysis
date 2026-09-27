import pino, { type Logger } from "pino";

export type { Logger };

const MAX_ERR_MESSAGE = 600;

function serializeError(err: unknown): Record<string, unknown> {
  if (!(err instanceof Error)) return { message: String(err).slice(0, MAX_ERR_MESSAGE) };
  const cause =
    err.cause instanceof Error ? err.cause.message.slice(0, MAX_ERR_MESSAGE) : undefined;
  return {
    type: err.name,
    message: err.message.slice(0, MAX_ERR_MESSAGE),
    ...(cause ? { cause } : {}),
    ...("code" in err ? { code: (err as { code: unknown }).code } : {}),
    stack: err.stack?.split("\n").slice(1, 6).join("\n"),
  };
}

export function createLogger(name: string, level = process.env.LOG_LEVEL ?? "info"): Logger {
  return pino({
    name,
    level,
    base: { service: name },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: ["req.headers.authorization", "req.headers['x-api-key']", "*.password", "*.token"],
    formatters: { level: (label) => ({ level: label }) },
    serializers: { err: serializeError, error: serializeError },
  });
}
