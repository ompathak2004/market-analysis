import type { NextConfig } from "next";

const previewOrigins =
  process.env.NEXT_ALLOWED_DEV_ORIGINS?.split(",")
    .map((o) => o.trim())
    .filter(Boolean) ?? [];

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  output: "standalone",
  allowedDevOrigins: previewOrigins,
};

export default config;
