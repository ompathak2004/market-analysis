import { defineConfig } from "vitest/config";

const conditions = ["@ma/source"];
const resolve = {
  resolve: { conditions },
  ssr: { resolve: { conditions, externalConditions: conditions } },
};

const DB_TESTS = [
  "packages/*/src/**/*.db.test.ts",
  "apps/*/src/**/*.db.test.ts",
  "apps/worker/src/handlers/relationships.test.ts",
  "apps/worker/src/queue.test.ts",
  "apps/web/src/server/queries/prices.test.ts",
  "packages/jobs/src/ledger.test.ts",
  "packages/ingest/src/pipelines/prices.test.ts",
];

export default defineConfig({
  ...resolve,
  test: {
    projects: [
      {
        ...resolve,
        test: {
          name: "unit",
          include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts"],
          exclude: ["**/node_modules/**", ...DB_TESTS],
        },
      },
      {
        ...resolve,
        test: {
          name: "db",
          include: DB_TESTS,
          pool: "forks",
          poolOptions: { forks: { singleFork: true } },
          testTimeout: 30_000,
        },
      },
    ],
  },
});
