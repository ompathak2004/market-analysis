import { sql } from "@ma/db";
import { getJobMode, type JobMode } from "@ma/jobs";
import type { AppContext } from "../context";

const CAMPAIGN_LIMIT = 50;
const ALERT_LIMIT = 100;

export interface JobsSummary {
  mode: JobMode;
  lease: {
    ownerId: string;
    generation: number;
    leasedUntil: string;
    heartbeatAt: string;
    alive: boolean;
  } | null;
  runs: Array<{ jobType: string; status: string; runs: number; last: string | null }>;
  daily: Array<{
    day: string;
    jobType: string;
    succeeded: number;
    failed: number;
    dead: number;
    deferred: number;
    abandoned: number;
  }>;
  campaigns: Array<{
    id: number;
    source: string;
    status: string;
    startedAt: string;
    childrenTotal: number;
    childrenDone: number;
    childrenFailed: number;
  }>;
  alerts: Array<{ kind: string; key: string; firstSeenAt: string; lastSeenAt: string }>;
}

export async function jobsSummary(ctx: AppContext): Promise<JobsSummary> {
  const [mode, leases, runs, daily, campaigns, alerts] = await Promise.all([
    getJobMode(ctx.db),
    ctx.db.execute<NonNullable<JobsSummary["lease"]>>(sql`
      select owner_id as "ownerId", generation::int as generation,
        leased_until::text as "leasedUntil", heartbeat_at::text as "heartbeatAt",
        leased_until > now() as alive
      from worker_leases where name = 'consumer'`),
    ctx.db.execute<JobsSummary["runs"][number]>(sql`
      select job_type as "jobType", status, count(*)::int as runs,
        max(coalesce(finished_at, started_at, created_at))::text as last
      from job_runs
      where coalesce(finished_at, started_at, created_at) > now() - interval '1 day'
        or status in ('queued', 'running', 'deferred')
      group by job_type, status order by job_type, status`),
    ctx.db.execute<JobsSummary["daily"][number]>(sql`
      select day::text as day, job_type as "jobType", succeeded, failed, dead, deferred, abandoned
      from job_daily_stats
      where day >= (now() at time zone 'utc')::date - 1
      order by day desc, job_type`),
    ctx.db.execute<JobsSummary["campaigns"][number]>(sql`
      select id, source, status, started_at::text as "startedAt",
        children_total as "childrenTotal", children_done as "childrenDone",
        children_failed as "childrenFailed"
      from ingest_runs
      where kind = 'campaign' and (status = 'running' or started_at > now() - interval '1 day')
      order by started_at desc limit ${CAMPAIGN_LIMIT}`),
    ctx.db.execute<JobsSummary["alerts"][number]>(sql`
      select kind, key, first_seen_at::text as "firstSeenAt", last_seen_at::text as "lastSeenAt"
      from ops_alerts where resolved_at is null
      order by last_seen_at desc limit ${ALERT_LIMIT}`),
  ]);
  return { mode, lease: leases[0] ?? null, runs, daily, campaigns, alerts };
}
