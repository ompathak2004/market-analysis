import path from "node:path";
import type { NextConfig } from "next";

const previewOrigins =
  process.env.NEXT_ALLOWED_DEV_ORIGINS?.split(",")
    .map((o) => o.trim())
    .filter(Boolean) ?? [];

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  outputFileTracingRoot: path.join(import.meta.dirname, "../../"),
  serverExternalPackages: ["pino", "thread-stream", "postgres", "ioredis", "cheerio", "unpdf"],
  allowedDevOrigins: previewOrigins,
};

export default config;
