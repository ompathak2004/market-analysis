import { Cache, createRedis } from "@ma/cache";
import { createLogger, loadServiceConfig, type ServiceConfig } from "@ma/core";
import { closeDb, createDb, llmUsage } from "@ma/db";
import { createIngestContext, type IngestContext } from "@ma/ingest";
import { API_CACHE } from "@ma/jobs";
import { createLlmClient, type LlmClient } from "@ma/llm";
import { z } from "zod";
import { type BufferedMetrics, createMetrics } from "./metrics.js";
import { S3ObjectStore } from "./storage.js";

export const APP_POOL_MAX = 2;
export const QUEUE_POOL_MAX = 1;

const flag = (def: "true" | "false") =>
  z
    .enum(["true", "false"])
    .default(def)
    .transform((v) => v === "true");

const workerEnvSchema = z.object({
  CLOUDWATCH_METRICS: flag("false"),
  AWS_REGION: z.string().default("ap-south-1"),
  WORKER_SCHEDULES: flag("true"),
  WORKER_DRAIN_MS: z.coerce.number().int().positive().max(100_000).default(90_000),
  OPS_DIGEST_TO: z
    .string()
    .optional()
    .transform((v) => v?.trim() || undefined),
  OPS_DIGEST_FROM: z.string().default("Market Analysis <onboarding@resend.dev>"),
  BACKUP_ENCRYPTION_KEY: z
    .string()
    .optional()
    .transform((v) => v?.trim() || undefined)
    .refine((v) => v === undefined || /^[0-9a-f]{64}$/i.test(v), "must be 64 hex characters"),
});

export type WorkerEnv = z.infer<typeof workerEnvSchema>;

export function loadWorkerEnv(env: NodeJS.ProcessEnv = process.env): WorkerEnv {
  return workerEnvSchema.parse(env);
}

export interface WorkerContext extends IngestContext {
  api: Cache;
  llm: LlmClient;
  env: WorkerEnv;
  metrics: BufferedMetrics;
}

export function createWorkerContext(
  name: string,
  config: ServiceConfig = loadServiceConfig(),
  env: WorkerEnv = loadWorkerEnv(),
): WorkerContext {
  const logger = createLogger(name, config.LOG_LEVEL);
  const db = createDb(config.DATABASE_URL, APP_POOL_MAX, { applicationName: name });
  const redis = createRedis(config.REDIS_URL);
  const objects = config.S3_ARCHIVE_BUCKET
    ? S3ObjectStore.fromEnv(config.S3_ARCHIVE_BUCKET, env.AWS_REGION)
    : null;
  const ingest = createIngestContext({ db, redis, config, logger, objects });
  const llm = createLlmClient({
    config,
    redis,
    logger,
    record: async (usage) => {
      await db
        .insert(llmUsage)
        .values(usage)
        .catch((err: unknown) => logger.warn({ err }, "llm usage insert failed"));
    },
  });
  const api = new Cache(redis, { ...API_CACHE, logger });
  const metrics = createMetrics(logger, {
    enabled: env.CLOUDWATCH_METRICS,
    region: env.AWS_REGION,
  });
  return { ...ingest, api, llm, env, metrics };
}

export async function closeWorkerContext(ctx: WorkerContext): Promise<void> {
  await closeDb(ctx.db);
  ctx.redis.disconnect();
}

export function queueConnection(url: string): {
  connectionString: string;
  ssl?: { rejectUnauthorized: false };
} {
  const parsed = new URL(url);
  const local = ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
  parsed.searchParams.delete("sslmode");
  return local
    ? { connectionString: parsed.toString() }
    : { connectionString: parsed.toString(), ssl: { rejectUnauthorized: false } };
}
