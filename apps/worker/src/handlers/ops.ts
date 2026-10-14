import { DAY, MINUTE } from "@ma/core";
import { type Db, sql } from "@ma/db";
import {
  abandonOverdueRuns,
  failStaleLegacyRuns,
  finalizeCampaigns,
  invalidateAfterJob,
  markOrphansDead,
  pruneLedger,
  pruneRetention,
  raiseAlert,
  resolveAlerts,
} from "@ma/jobs";
import type { Metrics } from "../batch.js";
import type { WorkerContext } from "../context.js";
import { DEAD_METRIC } from "../metrics.js";
import { done, type HandlerMap } from "../registry.js";

const OVERDUE_GRACE_MS = 2 * MINUTE;
const ORPHAN_AFTER_MS = 2 * DAY;
const LEGACY_STALE_MS = 15 * MINUTE;
const DEAD_ALERT = "jobs_dead";
const PRUNE_RESERVE_MS = 30_000;

export async function reconcile(db: Db): Promise<Metrics> {
  const abandoned = await abandonOverdueRuns(db, OVERDUE_GRACE_MS);
  const orphaned = await markOrphansDead(db, ORPHAN_AFTER_MS);
  const legacy = await failStaleLegacyRuns(db, LEGACY_STALE_MS);
  const campaigns = await finalizeCampaigns(db);
  const dead = await db.execute<{ job_type: string; dead: number }>(sql`
    select job_type, sum(dead)::int as dead from job_daily_stats
    where day >= (now() at time zone 'utc')::date - 1 and dead > 0
    group by job_type`);
  for (const row of dead) {
    await raiseAlert(db, { kind: DEAD_ALERT, key: row.job_type, payload: { dead: row.dead } });
  }
  const resolved = await resolveAlerts(
    db,
    DEAD_ALERT,
    dead.map((r) => r.job_type),
  );
  return { abandoned, orphaned, legacy, campaigns, deadTypes: dead.length, resolved };
}

type DigestRow = {
  job_type: string;
  succeeded: number;
  failed: number;
  dead: number;
  deferred: number;
  abandoned: number;
  avg_ms: number;
  max_ms: number;
};

export async function buildDigest(
  db: Db,
): Promise<{ subject: string; text: string; dead: number }> {
  const rows = await db.execute<DigestRow>(sql`
    select job_type, succeeded, failed, dead, deferred, abandoned,
      case when succeeded + failed + dead > 0
        then (duration_ms_total / (succeeded + failed + dead))::int else 0 end as avg_ms,
      duration_ms_max as max_ms
    from job_daily_stats
    where day = (now() at time zone 'utc')::date - 1
    order by dead desc, failed desc, job_type`);
  const alerts = await db.execute<{ kind: string; key: string; first_seen_at: string }>(sql`
    select kind, key, first_seen_at::text from ops_alerts
    where resolved_at is null order by first_seen_at`);
  const dead = rows.reduce((n, r) => n + Number(r.dead), 0);
  const lines = rows.map(
    (r) =>
      `${r.job_type.padEnd(22)} ok=${r.succeeded} failed=${r.failed} dead=${r.dead} deferred=${r.deferred} abandoned=${r.abandoned} avg=${r.avg_ms}ms max=${r.max_ms}ms`,
  );
  const alertLines = alerts.map((a) => `${a.kind}:${a.key} open since ${a.first_seen_at}`);
  const text = [
    "Job outcomes for the previous UTC day",
    "",
    ...(lines.length ? lines : ["no job activity recorded"]),
    "",
    "Open alerts",
    ...(alertLines.length ? alertLines : ["none"]),
  ].join("\n");
  return {
    subject: `market-analysis jobs: ${dead} dead, ${alerts.length} open alerts`,
    text,
    dead,
  };
}

async function sendDigest(ctx: WorkerContext, subject: string, text: string): Promise<boolean> {
  const key = ctx.config.RESEND_API_KEY;
  const { OPS_DIGEST_TO: to, OPS_DIGEST_FROM: from } = ctx.env;
  if (!key || !to) return false;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ from, to: to.split(",").map((s) => s.trim()), subject, text }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`resend responded ${res.status}`);
  return true;
}

type OpsHandlers = Pick<
  HandlerMap,
  "ops.reconcile" | "cache.invalidate" | "maintenance.prune" | "ops.digest"
>;

export const opsHandlers: OpsHandlers = {
  "ops.reconcile": async ({ ctx }) => {
    const metrics = await reconcile(ctx.db);
    if (metrics.orphaned) ctx.metrics.count(DEAD_METRIC, metrics.orphaned);
    return done(metrics);
  },
  "cache.invalidate": async ({ ctx, payload }) => {
    await invalidateAfterJob(ctx, payload.family);
    return done({ invalidated: 1 });
  },
  "maintenance.prune": async ({ ctx, signal, expired }) =>
    done({
      ...(await pruneLedger(ctx.db)),
      ...(await pruneRetention(ctx.db, { signal, expired: () => expired(PRUNE_RESERVE_MS) })),
    }),
  "ops.digest": async ({ ctx }) => {
    const digest = await buildDigest(ctx.db);
    ctx.logger.info({ subject: digest.subject, digest: digest.text }, "ops digest");
    const sent = await sendDigest(ctx, digest.subject, digest.text);
    return done({ dead: digest.dead, emailed: sent ? 1 : 0 });
  },
};
