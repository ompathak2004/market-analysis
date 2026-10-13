import { z } from "zod";

const optionalString = z
  .string()
  .optional()
  .transform((v) => {
    const trimmed = v?.trim();
    return trimmed ? trimmed : undefined;
  });

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  FIRECRAWL_API_KEY: z.string().min(1),
  FIRECRAWL_MONTHLY_CREDITS: z.coerce.number().int().positive().default(900),
  API_KEY: z.string().min(16),
  CRON_SECRET: z.string().min(16),
  CEREBRAS_API_KEY: z.string().min(1),
  CEREBRAS_MODEL: z.string().default("gpt-oss-120b"),
  CEREBRAS_FALLBACK_MODEL: z.string().default("qwen-3.8-27b"),
  CEREBRAS_RPM: z.coerce.number().int().positive().default(5),
  LLM_DAILY_TOKEN_BUDGET: z.coerce.number().int().positive().default(800_000),
  AISSTREAM_API_KEY: optionalString,
  OPENSKY_CLIENT_ID: optionalString,
  OPENSKY_CLIENT_SECRET: optionalString,
  ALTDATA_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  ALTDATA_AIS_BURST_SECONDS: z.coerce.number().int().positive().default(45),
  INTEL_UNIVERSE: z.string().default("NIFTY100"),
  DATA_UNIVERSE: z.string().default("NIFTY500"),
  NSE_BASE_URL: z.string().url().default("https://www.nseindia.com"),
  SCRAPE_CONCURRENCY: z.coerce.number().int().positive().default(4),
  ADMIN_API_KEY: optionalString,
  RESEND_API_KEY: optionalString,
  S3_ARCHIVE_BUCKET: optionalString,
});

export type Config = z.infer<typeof schema>;

let cached: Config | undefined;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (cached) return cached;
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment: ${issues}`);
  }
  cached = parsed.data;
  return cached;
}
