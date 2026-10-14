import { DAY, throwIfAborted } from "@ma/core";
import { type Db, sql } from "@ma/db";

export const RETENTION = {
  succeededRunsMs: 14 * DAY,
  failedRunsMs: 90 * DAY,
  dailyStatsMs: 400 * DAY,
  resolvedAlertsMs: 30 * DAY,
  campaignsMs: 90 * DAY,
  failedCampaignsMs: 180 * DAY,
  openTransitsMs: 30 * DAY,
  closedTransitsMs: 180 * DAY,
  altdataEventsMs: 180 * DAY,
  llmUsageMs: 90 * DAY,
  supersededInsightsMs: 180 * DAY,
  consensusHistoryMs: 5 * 365 * DAY,
  altdataFactsMs: 400 * DAY,
} as const;

export type Retention = typeof RETENTION;

export const PRUNE_BATCH = 1_000;

export const ABANDONED_TRANSIT = "abandoned";

export interface PruneResult {
  runs: number;
  stats: number;
  alerts: number;
}

export async function pruneLedger(
  db: Pick<Db, "execute">,
  retention: Retention = RETENTION,
): Promise<PruneResult> {
  const runs = await db.execute(sql`
    delete from job_runs
    where (status = 'succeeded'
        and finished_at < now() - (${retention.succeededRunsMs} * interval '1 millisecond'))
      or (status in ('dead', 'abandoned', 'failed')
        and coalesce(finished_at, created_at)
          < now() - (${retention.failedRunsMs} * interval '1 millisecond'))
    returning id`);
  const stats = await db.execute(sql`
    delete from job_daily_stats
    where day < (now() - (${retention.dailyStatsMs} * interval '1 millisecond'))::date
    returning day`);
  const alerts = await db.execute(sql`
    delete from ops_alerts
    where resolved_at < now() - (${retention.resolvedAlertsMs} * interval '1 millisecond')
    returning id`);
  return { runs: runs.length, stats: stats.length, alerts: alerts.length };
}

export interface RetentionResult {
  campaigns: number;
  abandonedTransits: number;
  transits: number;
  altdataEvents: number;
  llmUsage: number;
  insights: number;
  consensus: number;
  flights: number;
  vesselCalls: number;
  coverage: number;
  complete: number;
}

export interface RetentionOptions {
  expired?: () => boolean;
  signal?: AbortSignal;
  batch?: number;
  retention?: Retention;
}

type Fragment = ReturnType<typeof sql>;
type RetentionStep = keyof Omit<RetentionResult, "complete">;

const ago = (ms: number) => sql`now() - (${ms} * interval '1 millisecond')`;
const utcDayAgo = (ms: number) =>
  sql`(date_trunc('day', (now() at time zone 'utc') - (${ms} * interval '1 millisecond')) at time zone 'utc')`;
const counted = (statement: Fragment) =>
  sql`with gone as (${statement} returning 1) select count(*)::int as n from gone`;

const RETENTION_STEPS: ReadonlyArray<[RetentionStep, (r: Retention, limit: number) => Fragment]> = [
  [
    "campaigns",
    (r, limit) =>
      counted(sql`delete from ingest_runs where id in (
        select g.id from ingest_runs g
        where ((g.status = 'succeeded'
            and coalesce(g.finished_at, g.started_at) < ${ago(r.campaignsMs)})
          or (g.status = 'failed'
            and coalesce(g.finished_at, g.started_at) < ${ago(r.failedCampaignsMs)}))
          and exists (select 1 from ingest_runs n
            where n.source = g.source and n.status = g.status and n.id > g.id)
          and not exists (select 1 from job_runs j
            where j.campaign_id = g.id and j.status in ('queued', 'running', 'deferred'))
        order by g.id limit ${limit})`),
  ],
  [
    "abandonedTransits",
    (r, limit) =>
      counted(sql`update chokepoint_transits
        set left_at = entered_at + loiter_min * interval '1 minute', ended_by = ${ABANDONED_TRANSIT}
        where id in (select id from chokepoint_transits
          where left_at is null and entered_at < ${ago(r.openTransitsMs)}
          order by id limit ${limit})`),
  ],
  [
    "transits",
    (r, limit) =>
      counted(sql`delete from chokepoint_transits where id in (
        select id from chokepoint_transits where left_at < ${ago(r.closedTransitsMs)}
        order by id limit ${limit})`),
  ],
  [
    "altdataEvents",
    (r, limit) =>
      counted(sql`delete from altdata_events where id in (
        select id from altdata_events where occurred_at < ${ago(r.altdataEventsMs)}
        order by occurred_at limit ${limit})`),
  ],
  [
    "llmUsage",
    (r, limit) => sql`
      with gone as (
        delete from llm_usage where id in (
          select id from llm_usage where created_at < ${utcDayAgo(r.llmUsageMs)}
          order by created_at limit ${limit})
        returning created_at, model, kind, ok, prompt_tokens, completion_tokens, latency_ms),
      rolled as (
        insert into llm_usage_daily
          (day, model, kind, calls, failures, prompt_tokens, completion_tokens, latency_ms)
        select (created_at at time zone 'utc')::date, model, kind, count(*)::int,
          (count(*) filter (where not ok))::int, sum(prompt_tokens), sum(completion_tokens),
          sum(latency_ms)
        from gone group by 1, 2, 3
        on conflict (day, model, kind) do update set
          calls = llm_usage_daily.calls + excluded.calls,
          failures = llm_usage_daily.failures + excluded.failures,
          prompt_tokens = llm_usage_daily.prompt_tokens + excluded.prompt_tokens,
          completion_tokens = llm_usage_daily.completion_tokens + excluded.completion_tokens,
          latency_ms = llm_usage_daily.latency_ms + excluded.latency_ms
        returning 1)
      select count(*)::int as n from gone`,
  ],
  [
    "insights",
    (r, limit) =>
      counted(sql`delete from insights where id in (
        select id from insights where superseded_at < ${ago(r.supersededInsightsMs)}
        order by id limit ${limit})`),
  ],
  [
    "consensus",
    (r, limit) =>
      counted(sql`delete from consensus_history where ctid in (
        select ctid from consensus_history where month < (${ago(r.consensusHistoryMs)})::date
        limit ${limit})`),
  ],
  [
    "flights",
    (r, limit) =>
      counted(sql`delete from aircraft_flights where id in (
        select id from aircraft_flights
        where coalesce(arrived_at, departed_at, created_at) < ${ago(r.altdataFactsMs)}
        order by id limit ${limit})`),
  ],
  [
    "vesselCalls",
    (r, limit) =>
      counted(sql`delete from vessel_calls where id in (
        select id from vessel_calls where coalesce(left_at, entered_at) < ${ago(r.altdataFactsMs)}
        order by id limit ${limit})`),
  ],
  [
    "coverage",
    (r, limit) =>
      counted(sql`delete from altdata_coverage where ctid in (
        select ctid from altdata_coverage where day < (${ago(r.altdataFactsMs)})::date
        limit ${limit})`),
  ],
];

export async function pruneRetention(
  db: Pick<Db, "execute">,
  opts: RetentionOptions = {},
): Promise<RetentionResult> {
  const retention = opts.retention ?? RETENTION;
  const batch = opts.batch ?? PRUNE_BATCH;
  const result: RetentionResult = {
    campaigns: 0,
    abandonedTransits: 0,
    transits: 0,
    altdataEvents: 0,
    llmUsage: 0,
    insights: 0,
    consensus: 0,
    flights: 0,
    vesselCalls: 0,
    coverage: 0,
    complete: 0,
  };
  for (const [key, statement] of RETENTION_STEPS) {
    for (;;) {
      throwIfAborted(opts.signal);
      if (opts.expired?.()) return result;
      const rows = await db.execute<{ n: number }>(statement(retention, batch));
      const n = Number(rows[0]?.n ?? 0);
      result[key] += n;
      if (n < batch) break;
    }
  }
  result.complete = 1;
  return result;
}

export interface AlertInput {
  kind: string;
  key: string;
  payload: Record<string, unknown>;
}

export async function raiseAlert(db: Pick<Db, "execute">, alert: AlertInput): Promise<boolean> {
  const rows = await db.execute<{ fresh: boolean }>(sql`
    insert into ops_alerts (kind, key, payload)
    values (${alert.kind}, ${alert.key}, ${JSON.stringify(alert.payload)}::jsonb)
    on conflict (kind, key) do update set
      last_seen_at = now(),
      payload = excluded.payload,
      first_seen_at = case when ops_alerts.resolved_at is null
        then ops_alerts.first_seen_at else now() end,
      resolved_at = null
    returning (xmax = 0 or first_seen_at = last_seen_at) as fresh`);
  return rows[0]?.fresh === true;
}

export async function resolveAlerts(
  db: Pick<Db, "execute">,
  kind: string,
  activeKeys: readonly string[],
): Promise<number> {
  const keep = activeKeys.length
    ? sql`and key not in (${sql.join(
        activeKeys.map((k) => sql`${k}`),
        sql`, `,
      )})`
    : sql``;
  const rows = await db.execute(sql`
    update ops_alerts set resolved_at = now()
    where kind = ${kind} and resolved_at is null ${keep}
    returning id`);
  return rows.length;
}
