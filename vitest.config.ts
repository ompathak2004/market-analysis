import { defineConfig } from "vitest/config";

const conditions = ["@ma/source"];

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions, externalConditions: conditions } },
  test: { include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts"] },
});
