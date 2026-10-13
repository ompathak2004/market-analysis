import { DAY } from "@ma/core";
import { type Db, sql } from "@ma/db";

export const RETENTION = {
  succeededRunsMs: 14 * DAY,
  failedRunsMs: 90 * DAY,
  dailyStatsMs: 400 * DAY,
  resolvedAlertsMs: 30 * DAY,
} as const;

export interface PruneResult {
  runs: number;
  stats: number;
  alerts: number;
}

export async function pruneLedger(
  db: Pick<Db, "execute">,
  retention: typeof RETENTION = RETENTION,
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
