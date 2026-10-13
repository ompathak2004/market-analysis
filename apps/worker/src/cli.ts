import { setTimeout as sleep } from "node:timers/promises";
import { loadConfig } from "@ma/core";
import { eq, jobRuns, sql } from "@ma/db";
import {
  getJobMode,
  isJobMode,
  isJobType,
  JOB_TYPES,
  type JobType,
  parsePayload,
  setJobMode,
} from "@ma/jobs";
import { enqueue, ensureQueues } from "@ma/jobs/queue";
import { closeWorkerContext, createWorkerContext, type WorkerContext } from "./context.js";
import { createBoss } from "./queue.js";
import { SCHEDULE_TZ, SCHEDULES } from "./schedules.js";

export const FAMILY_ALIASES: Record<string, { type: JobType; payload?: Record<string, unknown> }> =
  {
    universe: { type: "universe.fanout" },
    prices: { type: "prices.fanout" },
    fundamentals: { type: "fundamentals.fanout" },
    announcements: { type: "announcements.fanout" },
    relationships: { type: "relationships.fanout" },
    intel: { type: "intel.fanout" },
    moneycontrol: { type: "research.fanout" },
    "broker-reports": { type: "broker.fetch" },
    insights: { type: "insights.fanout" },
    "market-brief": { type: "market-brief", payload: { slot: "manual" } },
    triage: { type: "triage.batch" },
    "broker-theses": { type: "broker.theses" },
    "aircraft-registry": { type: "aircraft.registry" },
    "aircraft-sample": { type: "aircraft.sample" },
    "ais-collect": { type: "ais.collect" },
    "altdata-derive": { type: "altdata.derive" },
    "altdata-signals": { type: "altdata.signals" },
    fleets: { type: "fleets" },
    "altdata-cleanup": { type: "altdata.cleanup" },
  };

const WAIT_POLL_MS = 3_000;
const WAIT_MAX_MS = 30 * 60_000;

const USAGE = `usage:
  cli run <job-type|legacy-name> [payload-json] [--wait]
  cli mode [legacy|paused|worker]
  cli status
  cli schedules
  cli types`;

export function resolveJob(
  name: string,
  rawPayload?: string,
): { type: JobType; payload: Record<string, unknown> } {
  const alias = FAMILY_ALIASES[name];
  const type = alias?.type ?? (isJobType(name) ? name : null);
  if (!type) throw new Error(`unknown job ${name}`);
  const payload = rawPayload ? (JSON.parse(rawPayload) as unknown) : (alias?.payload ?? {});
  return { type, payload: parsePayload(type, payload) as Record<string, unknown> };
}

async function runCommand(ctx: WorkerContext, args: string[]): Promise<void> {
  const wait = args.includes("--wait");
  const [name, rawPayload] = args.filter((a) => a !== "--wait");
  if (!name) throw new Error(USAGE);
  const { type, payload } = resolveJob(name, rawPayload);
  const boss = createBoss(ctx.config.DATABASE_URL, { schedule: false, supervise: false });
  boss.on("error", (err: unknown) => ctx.logger.warn({ err }, "pg-boss error"));
  await boss.start();
  try {
    await ensureQueues(boss);
    const result = await ctx.db.transaction((tx) =>
      enqueue(boss, { type, payload: payload as never }, tx),
    );
    console.log(JSON.stringify({ type, ...result }, null, 2));
    if (!wait || result.runId === null) return;
    const until = Date.now() + WAIT_MAX_MS;
    while (Date.now() < until) {
      const [row] = await ctx.db
        .select({ status: jobRuns.status, error: jobRuns.error, metrics: jobRuns.metrics })
        .from(jobRuns)
        .where(eq(jobRuns.id, result.runId));
      if (row && (row.status === "succeeded" || row.status === "dead")) {
        console.log(JSON.stringify(row, null, 2));
        if (row.status === "dead") process.exitCode = 1;
        return;
      }
      await sleep(WAIT_POLL_MS);
    }
    throw new Error(`run ${result.runId} did not finish within ${WAIT_MAX_MS / 60_000} minutes`);
  } finally {
    await boss.stop({ graceful: false, close: true });
  }
}

async function statusCommand(ctx: WorkerContext): Promise<void> {
  const [mode, runs, leases, alerts] = await Promise.all([
    getJobMode(ctx.db),
    ctx.db.execute(sql`
      select job_type, status, count(*)::int as runs, max(coalesce(finished_at, started_at, created_at)) as last
      from job_runs where created_at > now() - interval '1 day' or status in ('running', 'queued')
      group by job_type, status order by job_type, status`),
    ctx.db.execute(
      sql`select name, owner_id, generation, leased_until, heartbeat_at from worker_leases`,
    ),
    ctx.db.execute(
      sql`select kind, key, first_seen_at, last_seen_at from ops_alerts where resolved_at is null`,
    ),
  ]);
  console.log(JSON.stringify({ mode, leases, runs, alerts }, null, 2));
}

async function main(argv: string[]): Promise<void> {
  const [command, ...args] = argv;
  if (command === "types") {
    console.log(JOB_TYPES.join("\n"));
    return;
  }
  if (command === "schedules") {
    for (const s of SCHEDULES)
      console.log(`${s.id.padEnd(22)} ${s.cron.padEnd(20)} ${SCHEDULE_TZ} ${s.type}`);
    return;
  }
  if (command !== "run" && command !== "mode" && command !== "status") {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  const ctx = createWorkerContext("worker-cli", loadConfig());
  try {
    if (command === "run") await runCommand(ctx, args);
    else if (command === "status") await statusCommand(ctx);
    else {
      const next = args[0];
      if (next !== undefined) {
        if (!isJobMode(next)) throw new Error(USAGE);
        await setJobMode(ctx.db, next);
      }
      console.log(await getJobMode(ctx.db));
    }
  } finally {
    await closeWorkerContext(ctx);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
