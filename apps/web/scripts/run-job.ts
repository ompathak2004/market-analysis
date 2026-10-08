import { closeDb } from "@ma/db";
import { createAppContext } from "../src/server/context";
import { getJob, jobNames, runJob } from "../src/server/jobs/index";

const name = process.argv[2];
const def = name ? getJob(name) : undefined;
if (!def) {
  console.error(`usage: run-job <${jobNames().join("|")}>`);
  process.exit(1);
}
const ctx = createAppContext("job-cli");
try {
  const budget = Number(process.argv[3] ?? def.budgetMs);
  console.log(JSON.stringify(await runJob(ctx, def.name, budget, def.run), null, 2));
} finally {
  await closeDb(ctx.db);
  ctx.redis.disconnect();
}
