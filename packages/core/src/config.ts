import { z } from "zod";

const optionalString = z
  .string()
  .optional()
  .transform((v) => {
    const trimmed = v?.trim();
    return trimmed ? trimmed : undefined;
  });

const optionalPositiveInt = z.coerce.number().int().positive().optional();

const serviceSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  FIRECRAWL_API_KEY: z.string().min(1),
  FIRECRAWL_MONTHLY_CREDITS: z.coerce.number().int().positive().default(900),
  CEREBRAS_API_KEY: z.string().min(1),
  CEREBRAS_MODEL: z.string().default("gpt-oss-120b"),
  CEREBRAS_FALLBACK_MODEL: z.string().default("qwen-3.8-27b"),
  CEREBRAS_RPM: z.coerce.number().int().positive().default(5),
  LLM_DAILY_TOKEN_BUDGET: z.coerce.number().int().positive().default(800_000),
  LLM_BUDGET_RELATIONSHIPS: optionalPositiveInt,
  LLM_BUDGET_INSIGHTS: optionalPositiveInt,
  LLM_BUDGET_INFLUENCE: optionalPositiveInt,
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
  SPLC_PRESENTATIONS_PILOT: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  NSE_BASE_URL: z.string().url().default("https://www.nseindia.com"),
  SCRAPE_CONCURRENCY: z.coerce.number().int().positive().default(4),
  RESEND_API_KEY: optionalString,
  S3_ARCHIVE_BUCKET: optionalString,
});

const webSchema = serviceSchema.extend({
  API_KEY: z.string().min(16),
  ADMIN_API_KEY: optionalString,
});

export type ServiceConfig = z.infer<typeof serviceSchema>;
export type Config = z.infer<typeof webSchema>;

function withoutBlanks(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    const trimmed = value?.trim();
    if (trimmed) out[key] = trimmed;
  }
  return out;
}

function parse<S extends z.ZodTypeAny>(schema: S, env: NodeJS.ProcessEnv): z.infer<S> {
  const parsed = schema.safeParse(withoutBlanks(env));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment: ${issues}`);
  }
  return parsed.data;
}

let cached: Config | undefined;
let cachedService: ServiceConfig | undefined;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  cached ??= parse(webSchema, env);
  return cached;
}

export function loadServiceConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  cachedService ??= parse(serviceSchema, env);
  return cachedService;
}
