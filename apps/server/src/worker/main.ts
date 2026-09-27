import { closeAppContext, createAppContext } from "../context.js";
import { buildJobs } from "./jobs.js";
import { Scheduler } from "./scheduler.js";

const ctx = createAppContext("worker");
const scheduler = new Scheduler(ctx.db, ctx.redis, ctx.logger);
const jobs = buildJobs(ctx);

const only = process.argv[2];
if (only) {
  const job = jobs.find((j) => j.name === only);
  if (!job) throw new Error(`unknown job ${only}`);
  const { activeHoursIst: _ignored, ...forced } = job;
  await scheduler.runOnce(forced);
  await closeAppContext(ctx);
} else {
  scheduler.start(jobs);
  ctx.logger.info({ jobs: jobs.map((j) => j.name) }, "worker started");
  const shutdown = async () => {
    await scheduler.stop();
    await closeAppContext(ctx);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}
