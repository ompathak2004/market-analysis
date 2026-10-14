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
    ctx.db.execute<{
      owner_id: string;
      generation: number;
      leased_until: string;
      heartbeat_at: string;
      alive: boolean;
    }>(sql`
      select owner_id, generation, leased_until::text, heartbeat_at::text,
        leased_until > now() as alive
      from worker_leases where name = 'consumer'`),
    ctx.db.execute<{ job_type: string; status: string; runs: number; last: string | null }>(sql`
      select job_type, status, count(*)::int as runs,
        max(coalesce(finished_at, started_at, created_at))::text as last
      from job_runs
      where created_at > now() - interval '1 day' or status in ('running', 'queued')
      group by job_type, status order by job_type, status`),
    ctx.db.execute<{
      day: string;
      job_type: string;
      succeeded: number;
      failed: number;
      dead: number;
      deferred: number;
      abandoned: number;
    }>(sql`
      select day::text, job_type, succeeded, failed, dead, deferred, abandoned
      from job_daily_stats
      where day >= (now() at time zone 'utc')::date - 1
      order by day desc, job_type`),
    ctx.db.execute<{
      id: number;
      source: string;
      status: string;
      started_at: string;
      children_total: number;
      children_done: number;
      children_failed: number;
    }>(sql`
      select id, source, status, started_at::text, children_total, children_done, children_failed
      from ingest_runs
      where kind = 'campaign' and (status = 'running' or started_at > now() - interval '1 day')
      order by started_at desc limit ${CAMPAIGN_LIMIT}`),
    ctx.db.execute<{ kind: string; key: string; first_seen_at: string; last_seen_at: string }>(sql`
      select kind, key, first_seen_at::text, last_seen_at::text
      from ops_alerts where resolved_at is null
      order by last_seen_at desc limit ${ALERT_LIMIT}`),
  ]);
  const lease = leases[0];
  return {
    mode,
    lease: lease
      ? {
          ownerId: lease.owner_id,
          generation: Number(lease.generation),
          leasedUntil: lease.leased_until,
          heartbeatAt: lease.heartbeat_at,
          alive: lease.alive,
        }
      : null,
    runs: runs.map((r) => ({
      jobType: r.job_type,
      status: r.status,
      runs: Number(r.runs),
      last: r.last,
    })),
    daily: daily.map((d) => ({
      day: d.day,
      jobType: d.job_type,
      succeeded: Number(d.succeeded),
      failed: Number(d.failed),
      dead: Number(d.dead),
      deferred: Number(d.deferred),
      abandoned: Number(d.abandoned),
    })),
    campaigns: campaigns.map((c) => ({
      id: Number(c.id),
      source: c.source,
      status: c.status,
      startedAt: c.started_at,
      childrenTotal: Number(c.children_total),
      childrenDone: Number(c.children_done),
      childrenFailed: Number(c.children_failed),
    })),
    alerts: alerts.map((a) => ({
      kind: a.kind,
      key: a.key,
      firstSeenAt: a.first_seen_at,
      lastSeenAt: a.last_seen_at,
    })),
  };
}
