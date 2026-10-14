import { type Db, ingestRuns, jobRuns, sql, type Tx } from "@ma/db";
import type { Lane } from "./contracts.js";
import type { Lease } from "./lease.js";

export type { Tx };
export type Executor = Db | Tx;

export type RunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "dead"
  | "deferred"
  | "abandoned";

export type AttemptOutcome = Exclude<RunStatus, "queued" | "running">;

const MAX_ERROR = 1_000;

export function sanitizeError(err: unknown): string {
  const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return text
    .replace(/(postgres(ql)?|rediss?):\/\/[^\s@]+@/gi, "$1://***@")
    .replace(/(api[_-]?key|token|secret|password)=([^\s&]+)/gi, "$1=***")
    .slice(0, MAX_ERROR);
}

export function sanitizePayload(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (/key|token|secret|password/i.test(k)) continue;
    out[k] = typeof v === "string" ? v.slice(0, 200) : v;
  }
  return out;
}

export interface RunInput {
  type: string;
  unitKey: string;
  campaignId: number | null;
  lane: Lane;
  payload: Record<string, unknown>;
}

export async function ensureRun(db: Executor, input: RunInput): Promise<number> {
  const ids = await ensureRuns(db, [input]);
  const id = ids.get(runKey(input.type, input.unitKey));
  if (id === undefined) throw new Error(`job_runs upsert returned no id for ${input.unitKey}`);
  return id;
}

export function runKey(type: string, unitKey: string): string {
  return `${type}\u0000${unitKey}`;
}

export async function ensureRuns(db: Executor, inputs: RunInput[]): Promise<Map<string, number>> {
  if (!inputs.length) return new Map();
  const rows = await db
    .insert(jobRuns)
    .values(
      inputs.map((input) => ({
        jobType: input.type,
        unitKey: input.unitKey,
        campaignId: input.campaignId,
        lane: input.lane,
        payload: sanitizePayload(input.payload),
      })),
    )
    .onConflictDoUpdate({
      target: [jobRuns.jobType, jobRuns.unitKey, jobRuns.campaignId],
      set: {
        payload: sql`excluded.payload`,
        status: sql`case when ${jobRuns.status} in ('succeeded', 'dead') then 'queued'::job_status else ${jobRuns.status} end`,
        finishedAt: sql`case when ${jobRuns.status} in ('succeeded', 'dead') then null else ${jobRuns.finishedAt} end`,
      },
    })
    .returning({ id: jobRuns.id, type: jobRuns.jobType, unitKey: jobRuns.unitKey });
  return new Map(rows.map((r) => [runKey(r.type, r.unitKey), r.id]));
}

export async function deleteRun(db: Executor, runId: number): Promise<void> {
  await deleteRuns(db, [runId]);
}

export async function deleteRuns(db: Executor, runIds: number[]): Promise<void> {
  if (!runIds.length) return;
  await db.execute(sql`delete from job_runs where id in (${idList(runIds)}) and status = 'queued'`);
}

function fence(lease: Lease) {
  return sql`exists (select 1 from worker_leases
    where name = ${lease.name} and owner_id = ${lease.ownerId}
      and generation = ${lease.generation} and leased_until > now())`;
}

export interface StartInput {
  runId: number;
  attempt: number;
  deadlineAt: Date;
  queueJobId: string | null;
  lease: Lease;
}

export async function startAttempt(db: Executor, input: StartInput): Promise<number | null> {
  const rows = await db.execute<{ id: string | number }>(sql`
    with run as (
      update job_runs
        set status = 'running', attempt = ${input.attempt}, started_at = now(),
            deadline_at = ${input.deadlineAt.toISOString()}, finished_at = null, error = null
      where id = ${input.runId} and ${fence(input.lease)}
      returning id
    )
    insert into job_attempts (run_id, attempt, queue_job_id, worker_owner, generation)
    select id, ${input.attempt}, ${input.queueJobId}, ${input.lease.ownerId}, ${input.lease.generation}
    from run
    returning id`);
  const id = rows[0]?.id;
  return id === undefined ? null : Number(id);
}

export interface FinishInput {
  runId: number;
  attemptId: number;
  jobType: string;
  campaignId: number | null;
  outcome: AttemptOutcome;
  error: string | null;
  metrics: Record<string, number>;
  durationMs: number;
  lease: Lease;
}

export async function finishAttempt(db: Executor, input: FinishInput): Promise<boolean> {
  return db.transaction(async (tx) => {
    const updated = await tx.execute(sql`
      update job_runs
        set status = ${input.outcome}::job_status,
            finished_at = now(),
            error = ${input.error},
            metrics = ${JSON.stringify(input.metrics)}::jsonb
      where id = ${input.runId} and ${fence(input.lease)}
      returning id`);
    if (updated.length === 0) return false;
    await tx.execute(sql`
      update job_attempts set finished_at = now(), outcome = ${input.outcome}::job_status,
        error = ${input.error}
      where id = ${input.attemptId}`);
    await bumpDailyStats(tx, input.jobType, input.outcome, input.durationMs);
    if (input.campaignId !== null) await refreshCampaign(tx, input.campaignId);
    return true;
  });
}

export async function bumpDailyStats(
  db: Executor,
  jobType: string,
  outcome: AttemptOutcome,
  durationMs: number,
): Promise<void> {
  const column = sql.raw(outcome);
  const ms = Math.max(0, Math.round(durationMs));
  await db.execute(sql`
    insert into job_daily_stats (day, job_type, ${column}, duration_ms_total, duration_ms_max)
    values ((now() at time zone 'utc')::date, ${jobType}, 1, ${ms}, ${ms})
    on conflict (day, job_type) do update set
      ${column} = job_daily_stats.${column} + 1,
      duration_ms_total = job_daily_stats.duration_ms_total + excluded.duration_ms_total,
      duration_ms_max = greatest(job_daily_stats.duration_ms_max, excluded.duration_ms_max)`);
}

export async function createCampaign(
  db: Executor,
  source: string,
  parentJobId: string | null = null,
): Promise<number> {
  const [row] = await db
    .insert(ingestRuns)
    .values({ source, kind: "campaign", parentJobId })
    .returning({ id: ingestRuns.id });
  if (!row) throw new Error(`campaign insert returned no id for ${source}`);
  return row.id;
}

export async function findCampaign(
  db: Executor,
  parentJobId: string,
): Promise<{ campaignId: number; enqueued: number } | null> {
  const rows = await db.execute<{ id: number; children_total: number }>(sql`
    select id, children_total from ingest_runs where parent_job_id = ${parentJobId}`);
  const row = rows[0];
  return row ? { campaignId: Number(row.id), enqueued: Number(row.children_total) } : null;
}

export async function setCampaignTotal(
  db: Executor,
  campaignId: number,
  total: number,
  stats: Record<string, number>,
): Promise<void> {
  await db.execute(sql`
    update ingest_runs set children_total = ${total},
      stats = stats || ${JSON.stringify(stats)}::jsonb
    where id = ${campaignId}`);
  await refreshCampaign(db, campaignId);
}

export async function refreshCampaign(db: Executor, campaignId: number): Promise<void> {
  await db.execute(sql`
    with c as (
      select
        count(*) filter (where status = 'succeeded')::int as done,
        count(*) filter (where status = 'dead')::int as failed
      from job_runs where campaign_id = ${campaignId}
    )
    update ingest_runs r set
      children_done = c.done,
      children_failed = c.failed,
      status = case
        when r.status = 'running' and c.done + c.failed >= r.children_total
          then (case when c.failed > 0 then 'failed' else 'succeeded' end)::ingest_status
        else r.status end,
      finished_at = case
        when r.status = 'running' and c.done + c.failed >= r.children_total then now()
        else r.finished_at end,
      error = case
        when r.status = 'running' and c.done + c.failed >= r.children_total and c.failed > 0
          then c.failed || ' of ' || r.children_total || ' children failed'
        else r.error end,
      stats = r.stats || jsonb_build_object('done', c.done, 'failed', c.failed)
    from c
    where r.id = ${campaignId} and r.kind = 'campaign'`);
}

export async function abandonPriorAttempts(db: Db, lease: Lease): Promise<number> {
  return db.transaction(async (tx) => {
    const rows = await tx.execute<{ run_id: string | number }>(sql`
      update job_attempts set outcome = 'abandoned', finished_at = now(),
        error = 'consumer replaced while running'
      where outcome = 'running'
        and (worker_owner is distinct from ${lease.ownerId}
          or generation is distinct from ${lease.generation})
      returning run_id`);
    const runIds = [...new Set(rows.map((r) => Number(r.run_id)))];
    return markRunsAbandoned(tx, runIds, "consumer replaced while running");
  });
}

export async function abandonOverdueRuns(db: Db, graceMs: number): Promise<number> {
  return db.transaction(async (tx) => {
    const rows = await tx.execute<{ id: string | number }>(sql`
      select id from job_runs
      where status = 'running'
        and coalesce(deadline_at, started_at + interval '15 minutes')
          < now() - (${graceMs} * interval '1 millisecond')
      for update skip locked`);
    const runIds = rows.map((r) => Number(r.id));
    if (!runIds.length) return 0;
    await tx.execute(sql`
      update job_attempts set outcome = 'abandoned', finished_at = now(),
        error = 'deadline passed while running'
      where run_id in (${idList(runIds)}) and outcome = 'running'`);
    return markRunsAbandoned(tx, runIds, "deadline passed while running");
  });
}

export async function markOrphansDead(db: Db, olderThanMs: number): Promise<number> {
  return db.transaction(async (tx) => {
    const rows = await tx.execute<{ job_type: string; campaign_id: number | null }>(sql`
      update job_runs set status = 'dead', finished_at = now(),
        error = coalesce(error, 'no queued delivery left for this run')
      where (status in ('queued', 'failed', 'abandoned')
          and coalesce(finished_at, started_at, created_at)
            < now() - (${olderThanMs} * interval '1 millisecond'))
        or (status = 'deferred'
          and coalesce(finished_at, started_at, created_at) < now() - interval '35 days')
      returning job_type, campaign_id`);
    const campaigns = new Set<number>();
    for (const row of rows) {
      await bumpDailyStats(tx, row.job_type, "dead", 0);
      if (row.campaign_id !== null) campaigns.add(Number(row.campaign_id));
    }
    for (const id of campaigns) await refreshCampaign(tx, id);
    return rows.length;
  });
}

export interface RootOutcome {
  source: string;
  startedAt: Date;
  status: "succeeded" | "failed";
  stats: Record<string, number>;
  error: string | null;
}

export async function recordRootOutcome(db: Executor, outcome: RootOutcome): Promise<void> {
  const failed = outcome.status === "failed" ? 1 : 0;
  await db.insert(ingestRuns).values({
    source: outcome.source,
    kind: "campaign",
    status: outcome.status,
    startedAt: outcome.startedAt,
    finishedAt: new Date(),
    stats: outcome.stats,
    error: outcome.error,
    childrenTotal: 1,
    childrenDone: 1 - failed,
    childrenFailed: failed,
  });
}

function idList(ids: number[]) {
  return sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  );
}

async function markRunsAbandoned(tx: Tx, runIds: number[], reason: string): Promise<number> {
  if (!runIds.length) return 0;
  const rows = await tx.execute<{ job_type: string; campaign_id: number | null }>(sql`
    update job_runs set status = 'abandoned', finished_at = now(), error = ${reason}
    where id in (${idList(runIds)}) and status = 'running'
    returning job_type, campaign_id`);
  for (const row of rows) await bumpDailyStats(tx, row.job_type, "abandoned", 0);
  return rows.length;
}

export async function finalizeCampaigns(db: Executor): Promise<number> {
  const rows = await db.execute<{ id: number }>(sql`
    select id from ingest_runs where kind = 'campaign' and status = 'running'`);
  for (const row of rows) await refreshCampaign(db, Number(row.id));
  return rows.length;
}

export async function markRunDead(
  db: Db,
  target: { runId: number } | { jobType: string; unitKey: string; campaignId: number | null },
  error: string,
): Promise<boolean> {
  const where =
    "runId" in target
      ? sql`id = ${target.runId}`
      : sql`job_type = ${target.jobType} and unit_key = ${target.unitKey}
          and campaign_id is not distinct from ${target.campaignId}`;
  return db.transaction(async (tx) => {
    const rows = await tx.execute<{ job_type: string; campaign_id: number | null }>(sql`
      update job_runs set status = 'dead', finished_at = now(), error = ${error}
      where ${where} and status not in ('succeeded', 'dead')
      returning job_type, campaign_id`);
    const row = rows[0];
    if (!row) return false;
    await bumpDailyStats(tx, row.job_type, "dead", 0);
    if (row.campaign_id !== null) await refreshCampaign(tx, Number(row.campaign_id));
    return true;
  });
}
