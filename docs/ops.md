# Operations runbook

## What runs where

| Component | Where | Notes |
| --- | --- | --- |
| Web UI, `/api/v1` read API | Vercel (`apps/web`) | Reads Postgres/Redis; no scheduled work after cutover. |
| Queue worker, schedules, all ingestion/intel/LLM jobs | AWS ECS Fargate, `ap-south-1`, cluster `market-analysis`, service `market-analysis-worker` (`apps/worker`) | One task (0.5 vCPU / 1 GiB), Spot by default. Image in ECR `market-analysis-worker`, tagged by git sha. Infra in `infra/aws` (see its README). |
| Queue (pg-boss), run ledger, `job_control` | Aiven Postgres | Same database as the data. |
| Cache, rate limits, LLM/Firecrawl budgets | Managed Redis | |
| Archive (DB backups under `backups/`, document blobs) | S3 `market-analysis-archive-146552917880` | `backups/` expires after 90 days. |
| Worker logs | CloudWatch Logs `/market-analysis/worker` | 14-day retention. |
| Secrets | SSM Parameter Store `/market-analysis/prod/*` (SecureString) | Read by the task at start; `MIGRATION_DATABASE_URL` is read only by CI. |
| Deploys | GitHub Actions (`infra/aws/github-workflow-worker.yml`, to be copied to `.github/workflows/worker.yml`) | Push to `main` touching the worker: verify → image → `pnpm db:migrate` → new task definition → rolling (stop-then-start) deploy. A failed migration stops the job before the deploy. |

## Database roles and connection budget

Aiven's free plan allows 15 connections (12 usable) and has no pooler, so the budget is enforced by role connection limits rather than by each process's pool size:

| Role | Used by | Connection limit | Timeouts (statement / lock / idle in transaction) | Rights |
| --- | --- | --- | --- | --- |
| `ma_worker` | ECS worker and its CLI (`DATABASE_URL` in SSM) | 3 (pg-boss pool 1 + app pool 2) | 30 s / 2 s / 15 s | DML on `public`, owner of schema `pgboss` |
| `ma_web` | Vercel (`DATABASE_URL` in the Vercel project) | 5 | 5 s / 1 s / 10 s | `SELECT` on `public`, read-only transactions, no access to `pgboss` |
| `ma_migrator` | `pnpm db:migrate` in CI (`MIGRATION_DATABASE_URL` in SSM) | 1 | none / 10 s / none | Owner of the application tables in `public` and of schema `drizzle`; `CREATE` on `public` and the database |
| admin (`avnadmin`) | The bootstrap script only | Aiven default | none | Creates roles, transfers ownership |

A fourth worker connection fails with `too many connections for role "ma_worker"` instead of starving the web app. Every Vercel instance counts against the same 5, so keep the web pool at `max=2`.

Create or update the roles (idempotent; rerun after changing `packages/db/roles/bootstrap.sql`):

```bash
psql "$ADMIN_URL" -v migrator_password="$MIGRATOR_PW" -v worker_password="$WORKER_PW" \
  -v web_password="$WEB_PW" [-v owner_role=avnadmin] -f packages/db/roles/bootstrap.sql
```

Pass `-v owner_role=avnadmin` on the first run against a database whose migrations were applied as the admin. It transfers the tables, sequences, types and functions in `public` and `drizzle` owned by that role to `ma_migrator`, so later migrations run as `ma_migrator` can alter them. Ownership transfer briefly takes an exclusive lock on each table, so run it while the worker is scaled to 0. Later reruns don't need the variable. Each rerun also revokes anything beyond `SELECT` that `ma_web` holds, so a manual grant can't leave the web role writable.

The script also creates schema `pgboss` owned by `ma_worker` and transfers any existing pg-boss tables to it, so pg-boss can run its own migrations at start without `CREATE` on the database. The worker only asks pg-boss to create the schema when it is missing and the role is allowed to, so run the script before the first worker start. Default privileges cover tables created later by the admin or by `ma_migrator`, so new tables get the worker and web grants without rerunning the script.

Cutover order: run `pnpm db:migrate` as the admin one last time (migrations through `0004_campaign_parent_job`), run the bootstrap script with `-v owner_role=avnadmin`, set the SSM `MIGRATION_DATABASE_URL` to the `ma_migrator` URL, set the SSM `DATABASE_URL` to the `ma_worker` URL (then force a new deployment), and set the Vercel `DATABASE_URL` to the `ma_web` URL. The worker reads only the shared variables; `API_KEY`, `CRON_SECRET` and `ADMIN_API_KEY` belong to the web app and are not stored for the worker.

## Pause, resume, enqueue

The authoritative switch is the `job_control` row (`legacy` = old Vercel crons, `paused` = nobody claims work, `worker` = the ECS worker runs schedules and jobs). Changing it does not need a deploy.

From a laptop with the production `.env` loaded (`set -a && . ./.env && set +a`):

```bash
pnpm --filter @ma/worker cli control paused     # stop claiming new work; in-flight units finish
pnpm --filter @ma/worker cli control worker     # resume
pnpm --filter @ma/worker cli status             # mode, lease holder, queue depth, recent failures
pnpm --filter @ma/worker cli enqueue prices.sync '{"companyId":123}'
```

The same commands inside the running task (see `infra/aws/README.md`, "Exec into the running task") are `node dist/cli.js control paused` and so on.

To stop the container entirely: `aws ecs update-service --cluster market-analysis --service market-analysis-worker --desired-count 0` (alarms `worker-not-running` and `worker-no-heartbeat` will fire; that is expected). Set it back to `1` to resume.

## Reading the ledger

`job_runs` has one row per logical unit (`job_type`, `unit_key`, `campaign_id`), `job_attempts` one row per delivery attempt, and `ingest_runs` rows with `kind = 'campaign'` summarise a fan-out (`children_total/done/failed`). Read-only queries:

```sql
-- what is running now and since when
select id, job_type, unit_key, attempt, started_at, deadline_at
from job_runs where status = 'running' order by started_at;

-- outcomes in the last 24 h
select job_type, status, count(*) from job_runs
where coalesce(finished_at, created_at) > now() - interval '24 hours'
group by 1, 2 order by 1, 2;

-- dead units and their last error
select r.id, r.job_type, r.unit_key, r.attempt, left(r.error, 200) as error, r.finished_at
from job_runs r where r.status = 'dead' order by r.finished_at desc limit 50;

-- attempt history of one unit
select attempt, outcome, started_at, finished_at, left(error, 200) as error
from job_attempts where run_id = $1 order by attempt;

-- campaigns
select id, source, status, children_total, children_done, children_failed, started_at, finished_at
from ingest_runs where kind = 'campaign' order by started_at desc limit 20;

-- worker lease (who is consuming, last heartbeat)
select name, owner_id, generation, leased_until, heartbeat_at from worker_leases;
```

A `running` row older than its `deadline_at` means the attempt was lost; the reconciler marks it `abandoned` and the unit retries. Gate after cutover: no `running` rows older than 15 minutes for 24 hours.

## Alarms

All alarms email the SNS topic `market-analysis-alerts` (subscription must be confirmed) and send an OK message on recovery.

| Alarm | Fires when | First checks |
| --- | --- | --- |
| `worker-no-heartbeat` | No `MarketAnalysis/worker.heartbeat` datapoint for 15 minutes (missing data counts as breaching). | Is the task running (`aws ecs describe-services ...`)? Logs for crash loops or `Invalid environment`. Is `job_control` set to `paused` while the process is alive but idle? Lease lost to another consumer? |
| `worker-not-running` | No running task for 10 minutes (no `AWS/ECS` CPU samples for the service). | `aws ecs describe-services --cluster market-analysis --services market-analysis-worker --query 'services[0].events[:10]'`: Spot capacity, image pull, missing SSM parameter, circuit-breaker rollback. |
| `worker-dead-jobs` | `MarketAnalysis/jobs.dead` sum > 0 in a 5-minute window. | Dead-unit query above; fix the cause, then re-enqueue the unit with `cli enqueue`. |

The budget (`market-analysis-prod-monthly`) emails `AlertEmail` at 80 % and 100 % of actual monthly spend.

## Spot interruptions

Fargate Spot sends SIGTERM with a two-minute warning; the task definition's `stopTimeout` is 120 s. The worker stops claiming, aborts in-flight network work, records abandoned attempts and exits; unfinished units stay retryable and are picked up by the replacement task (ECS starts it automatically, usually within a few minutes). Interruptions show up as service events and as a short heartbeat gap. If Spot capacity is repeatedly unavailable or a long campaign keeps getting interrupted, switch to on-demand (`UseSpot=false`, see `infra/aws/README.md`).

## Rollback

1. `pnpm --filter @ma/worker cli control paused` if the bad release is writing bad data.
2. Redeploy the previous task definition revision (the image is pinned by sha in each revision):

   ```bash
   aws ecs list-task-definitions --family-prefix market-analysis-worker --sort DESC --max-items 5
   aws ecs update-service --cluster market-analysis --service market-analysis-worker \
     --task-definition market-analysis-worker:<previous revision>
   aws ecs wait services-stable --cluster market-analysis --services market-analysis-worker
   ```

3. `cli control worker` once the old version is running.

Migrations are additive (expand/contract), so the previous image runs against the new schema; never downgrade the schema by hand. The deployment circuit breaker already rolls back automatically when a new revision cannot reach a running state. Never re-enable the Vercel crons as a rollback.

## Cost

Expected ≈ $11/month on Spot (≈ $6–7 compute, ≈ $3.6 for the task's public IPv4 address, under $2 for S3, logs, metrics, alarms and ECR); ≈ $24 on on-demand Fargate, which exceeds the default $20 budget. Breakdown and assumptions in `infra/aws/README.md`. Check AWS Cost Explorer (service and usage type) a week after launch against this estimate.
