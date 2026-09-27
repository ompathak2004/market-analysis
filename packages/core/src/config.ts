import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  FIRECRAWL_API_KEY: z.string().min(1),
  API_PORT: z.coerce.number().int().positive().default(4000),
  API_KEY: z.string().min(16),
  CORS_ORIGINS: z.string().default("http://localhost:3000"),
  NSE_BASE_URL: z.string().url().default("https://www.nseindia.com"),
  SCRAPE_CONCURRENCY: z.coerce.number().int().positive().default(4),
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
