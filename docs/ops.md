# Operations runbook

## Regional exposure and alt-data v2 rollout

Apply migrations `0013_altdata_provenance` and `0014_company_operating_sites` before deploying readers or the worker. They add columns and tables without deleting stored data. New tables inherit the existing role grants described below. Rebuild both applications; the workspace build filter uses double quotes so the same command works under Windows and POSIX shells.

After worker deployment, run `aircraft.registry` to refresh facility jurisdictions, `influence.states` to ingest the official chief-minister directory, `aircraft.repair` to enqueue bounded historical trace reads, and `altdata.signals` after the repair campaign settles. The new schedules repeat state leadership daily at 04:20 IST and historical repair at 02:40 IST. State refresh uses the Firecrawl monthly budget; trace repair uses the existing adsb.lol HTTP bucket. Web never enqueues these jobs.

`aircraft.trace` also accepts `{ "aircraftId": 123, "date": "2026-10-11" }`; historical reads require one aircraft and a real UTC date within 30 days. A pass plans at most 60 units. Unavailable source days cool down for six hours, successfully read days for seven days. The source may still lack either endpoint. Inspect endpoint methods and parser version rather than using a target percentage of filled airports as a success metric.

For a stored company filing or official company-location document, `influence.sites` accepts `{ "companyId": 123, "documentId": 456, "sites": [{ "name": "Hosur", "stateCode": "IN-TN", "stateName": "Tamil Nadu", "quote": "Hosur in Tamil Nadu" }] }`. The quote must occur verbatim in the immutable current revision and directly associate the location with the named state. The document must belong to that company. A successful import replaces that document's site set atomically; a failed import writes nothing. A newer revision hides those locations until they are re-imported. Do not invent coordinates to make a disclosed region appear on a transport map.

Travel/logistics model version 2 is selected explicitly by the read models. Run `altdata.signals` during rollout; version 1 signals remain stored for comparison but are not served as current. The INFL pane treats electoral bonds as historical funding and shows regional operations separately from confirmed political paths. Full research and unfinished acquisition work: `docs/influence-and-altdata-research.md`.

## What runs where

| Component | Where | Notes |
| --- | --- | --- |
| Web UI, `/api/v1` read API | Vercel (`apps/web`) | Reads Postgres/Redis; no scheduled work after cutover. |
| Queue worker, schedules, all ingestion/intel/LLM jobs | AWS ECS Fargate, `ap-south-1`, cluster `market-analysis`, service `market-analysis-worker` (`apps/worker`) | One task (0.25 vCPU / 1 GiB), Spot by default. Image in ECR `market-analysis-worker`, tagged by git sha. Infra in `infra/aws` (see its README). |
| Queue (pg-boss), run ledger, `job_control` | Aiven Postgres | Same database as the data. |
| Cache, rate limits, LLM/Firecrawl budgets | Managed Redis | |
| Archive (DB backups under `backups/`, document blobs) | S3 `market-analysis-archive-543588327217` | `backups/` expires after 90 days. |
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

The admin is granted `SET` and `INHERIT` membership in `ma_migrator` and `ma_worker` because a `CREATEROLE` admin (Aiven's `avnadmin`) only gets `ADMIN` on the roles it creates, which is not enough to create objects owned by them or to set their default privileges. `ma_migrator` keeps `CREATE` on the database because drizzle runs `CREATE SCHEMA IF NOT EXISTS drizzle` on every migrate. Ownership transfer is scoped to `public` and `drizzle` rather than `REASSIGN OWNED`, which would also hand over the database and every other schema the admin owns.

`ma_web` writes nothing directly. Reviewer decisions go through the `SECURITY DEFINER` functions `review_relationship(bigint, review_decision, text, text)` and `review_influence_edge(bigint, text, text, text, integer)`; their migrations revoke `EXECUTE` from `PUBLIC` and the bootstrap script grants it to `ma_web` only. Each grant is skipped while its function does not exist yet, so rerun the script after the migration that adds one. Because `ma_web` defaults to read-only transactions, the web app calls these functions inside an explicit `read write` transaction.

Cutover order: run `pnpm db:migrate` as the admin one last time (migrations through `0004_campaign_parent_job`), run the bootstrap script with `-v owner_role=avnadmin`, set the SSM `MIGRATION_DATABASE_URL` to the `ma_migrator` URL, set the SSM `DATABASE_URL` to the `ma_worker` URL (then force a new deployment), and set the Vercel `DATABASE_URL` to the `ma_web` URL. The worker reads only the shared variables; `API_KEY` and `ADMIN_API_KEY` belong to the web app and are not stored for the worker.

## SPLC review queue

Set `ADMIN_API_KEY` (a long random string) in the Vercel project to enable review. Without it `/admin/*` and `/api/v1/admin/*` answer 404.

- Sign in at `/admin/login` with the key. It sets the `ma_admin` cookie (expiry signed with HMAC-SHA256 keyed by `ADMIN_API_KEY`; `HttpOnly`, `SameSite=Strict`, `Secure` in production) for 12 hours. Login attempts are rate limited per IP (10 per 15 minutes). Rotating the key signs every session out.
- `/admin/review` lists pending `relationship_observations` with confidence below 0.8 or a new counterparty, oldest first, 50 per page. Select a row with `j`/`k` and press `c` confirm, `r` reject or `b` twice to block the pair. The note field applies to the next decision.
- Each decision runs `review_relationship()`, writes `relationship_reviews` and clears the `supply-chain:` cache for the companies on both sides.

The same API accepts the key as a header for scripts:

```bash
curl -s -H "x-admin-key: $ADMIN_API_KEY" "$WEB_URL/api/v1/admin/relationships/reviews?limit=20"
curl -s -H "x-admin-key: $ADMIN_API_KEY" "$WEB_URL/api/v1/admin/relationships/reviews?cursor=$NEXT_CURSOR"
curl -s -X POST -H "x-admin-key: $ADMIN_API_KEY" -H "content-type: application/json" \
  -d '{"observationId": 123, "decision": "reject", "note": "competitor mention"}' \
  "$WEB_URL/api/v1/admin/relationships/reviews"
```

`GET` returns `{items, nextCursor}`; `POST` takes `decision` `confirm`, `reject` or `block` and returns `{reviewId, observationStatus, relationshipId}`. Errors use `{error: {code, message}}`: 400 for a bad body or cursor, 401 for a missing or wrong key, 404 for an unknown observation or when review is disabled.

## SPLC precision gate

Legacy SPLC rows are deleted only after a labelled sample of the rebuilt graph shows at least 90 % precision. A sample is a frozen, seeded draw of `relationship_observations` in status `auto`, `confirmed` or `rejected` whose supplier, customer and cost bucket match an `active` edge.

```bash
pnpm --filter @ma/worker cli run relationships.sample '{"name":"gate-2026-10","size":100}' --wait
pnpm --filter @ma/worker cli run relationships.sample '{"name":"gate-2026-10-ar","size":100,"family":"annual_report"}' --wait
```

`name` (`[a-z0-9_-]`, up to 64 characters) is required and unique; rerunning with an existing name returns the stored sample (`created: 0`) without drawing again. `size` defaults to 100 (max 500), `family` limits the draw to one extractor family, and `seed` (default: the name) fixes the order. The job fails without retry when no observation qualifies.

Review the sample at `/admin/review?sample=gate-2026-10`. The SPLC pane lists only the sample's undecided items in draw order, with the same keys as the normal queue, and a gate line above them shows the counts, the precision, the Wilson 95 % lower bound and PASS or FAIL. An item counts as decided by its latest review; items blocked through another observation's pair block count as blocked. Rejected and blocked items count against precision.

```bash
curl -s -H "x-admin-key: $ADMIN_API_KEY" "$WEB_URL/api/v1/admin/relationships/precision?sample=gate-2026-10"
```

It returns `{sample, counts: {items, reviewed, confirmed, rejected, blocked, unreviewed}, precision, lowerBound, gate, passes}` and 404 for an unknown sample. `passes` is true only when every one of the `size` drawn items has a decision and `lowerBound` ≥ 0.9; with 100 items that needs 96 confirmations (95 gives 0.888). If observations are deleted after the draw (`counts.items` < `sample.size`), the sample can no longer pass; draw a new one under a new name.

## Pause, resume, enqueue

The authoritative switch is the `job_control` row (`paused` = nobody claims work, `worker` = the ECS worker runs schedules and jobs; migration `0011` removed `legacy`). Changing it does not need a deploy. `GET /api/v1/ops/jobs` (`x-admin-key: $ADMIN_API_KEY`) returns the same picture from the web app: mode, lease, `job_runs` by type and status for the last 24 h, `job_daily_stats`, running campaigns and unresolved `ops_alerts`.

From a laptop with the production `.env` loaded (`set -a && . ./.env && set +a`):

```bash
pnpm --filter @ma/worker cli mode paused     # stop claiming new work; in-flight units finish
pnpm --filter @ma/worker cli mode worker     # resume
pnpm --filter @ma/worker cli status             # mode, lease holder, queue depth, recent failures
pnpm --filter @ma/worker cli enqueue prices.sync '{"companyId":123}'
```

The same commands inside the running task (see `infra/aws/README.md`, "Exec into the running task") are `node dist/cli.js mode paused` and so on.

To stop the container entirely: `aws ecs update-service --cluster market-analysis --service market-analysis-worker --desired-count 0` (alarms `worker-not-running` and `worker-no-heartbeat` will fire; that is expected). Set it back to `1` to resume.

## Price history

Schedules (Asia/Kolkata): `prices.daily` at 18:30 and `prices.catchup` at 08:15 both run `prices.fanout`, which enqueues `index.daily` for the seven indices, `prices.daily` for every equity series (last ten sessions) and `prices.rebuild` for any series marked `rebuild_required`. `prices.repair` at 03:00 reconciles stored rows against the NSE calendar, then enqueues `prices.window` refetches (up to 500) for open gaps that are due, plus any pending rebuilds.

One-off five-year backfill, after `pnpm db:migrate` and a `universe` run (which seeds the seven indices); the backfill creates any missing `price_series_state` rows itself:

```bash
pnpm --filter @ma/worker cli run prices.backfill --wait     # alias: prices-backfill
```

The fanout writes one `prices.window` unit per series per annual window: (companies + 7 indices) x 5, so about 2,675 units for the 528-company campaign universe (2,540 against the 501 companies in the local test database). Yahoo history calls share the `yahoo:history` bucket (5 per 10 s), so expect about 1.5 to 3 hours end to end. Queue priority is calendar index (`^NSEI`, which populates `trading_sessions`) 3, other indices 2, rebuild 1, daily 0, equity backfill -1. The priority is carried in the job envelope and re-sent on every app-managed retry and deferral, so a retried calendar window stays ahead of equity windows. Priority only orders the queue, so an equity window also checks the calendar before it fetches: the calendar must reach the window end and have no stretch of more than 7 days without a session across the window, counting to the nearest session on each side. If it does not, the unit is deferred 3 minutes (`calendar_pending`) without spending an attempt, up to 60 deferrals before it fails. Units are keyed by symbol, window, generation and parser version. Rerunning the backfill refetches every window, but unchanged rows are not rewritten (a replay reports `unchanged`). Every company gets a `price_series_state` row. Companies without a Yahoo symbol (`no_yahoo_symbol`), missing from the NSE equity list while not delisted (`not_in_nse_equity_list`) or with a different ISIN there (`isin_mismatch`) get `exception_reason` set and `quality_status = 'exception'`, and are not enqueued (daily, rebuild, repair and `prices.sync` skip them too). `listing_source_unavailable` (NSE list down) is recorded but still fetched. Each backfill run freezes a manifest in one transaction: a `price_manifests` row (`kind = 'backfill'`, desired window, company and unit counts) and one `price_manifest_companies` row per company with its series, symbol, unit count and exception. The campaign metrics carry `manifestId`.

A unit succeeds only when every expected session in its window is stored or explained. Otherwise the rows that did arrive are committed, the result is `incomplete` (the detail is on `price_series_state.detail`) and the unit fails with `price_incomplete`, so the ledger retries it with backoff and finally marks it `dead` (alarm `worker-dead-jobs`). Sessions before Yahoo's first trade date are recorded as `prelisting` gaps and do not fail the unit. The result carries the source's answer separately from coverage, as `sourceStatus` (metric `source_<status>`). `not_found` (Yahoo returned nothing for a window that has expected sessions) and `invalid_response` (the bars failed validation, recorded as an `invalid_bars` gap) also fail the unit with `price_incomplete` and retry, even when earlier runs already stored every row. `identity_mismatch` (the Yahoo symbol is not uniquely owned by this series in `market_symbols`) is not retried: nothing is fetched, the series gets `exception_reason = 'identity_mismatch'` and `quality_status = 'exception'`, and every later unit skips it until the identity is fixed by hand (see `docs/plan.md`). `prices.window` units in `repair` mode are the exception to retrying: a gap that is still missing just moves its `next_check_at` (a calendar deferral still defers). A company is marked price-synced (by `prices.daily` or `prices.sync`) only when its window is complete, the source answered, and coverage reaches the latest finalized session (`desired_to`, the last NSE session before today). A company with no fetchable series is never marked synced.

Rebuilds are automatic: a window that sees a new or corrected split or dividend marks the series `rebuild_required` and the next fanout or repair enqueues `prices.rebuild`. To force one: `pnpm --filter @ma/worker cli run prices.rebuild '{"seriesId":72,"symbol":"RELIANCE.NS","generation":3,"parserVersion":1}'`, where `generation` is the current `price_series_state.adjustment_generation` + 1. A stale generation is refused with `stale_generation`. A rebuild must return every expected session that is not already an open or exempt gap. If it does not, nothing is written or deleted, the old generation stays served, the result is `rebuild_incomplete` with the missing range in `price_series_state.detail`, and the unit retries. An empty or failed source response is refused the same way (`source returned no bars`).

Acceptance checks (read-only transaction):

Start from `companies`, not from `price_series_state`, so a company with no series row or no Yahoo symbol still shows up:

```sql
-- coverage of every company; NULL quality means no series row (should be zero rows)
SELECT coalesce(s.quality_status, 'no_series') AS quality, s.exception_reason, count(*)
FROM companies c LEFT JOIN price_series_state s ON s.company_id = c.id
GROUP BY 1, 2 ORDER BY 3 DESC;

-- the latest frozen backfill manifest against the current companies table
WITH m AS (SELECT * FROM price_manifests WHERE kind = 'backfill' ORDER BY id DESC LIMIT 1)
SELECT m.id, m.desired_from, m.desired_to, m.companies, m.units,
       (SELECT count(*) FROM companies) AS companies_now,
       (SELECT count(*) FROM price_manifest_companies mc WHERE mc.manifest_id = m.id
         AND mc.exception_reason IS NOT NULL) AS exceptions
FROM m;

-- companies in the latest manifest that are neither complete nor an explained exception
SELECT c.nse_symbol, mc.units, mc.exception_reason, s.quality_status, s.detail
FROM price_manifest_companies mc
JOIN companies c ON c.id = mc.company_id
LEFT JOIN price_series_state s ON s.company_id = c.id
WHERE mc.manifest_id = (SELECT max(id) FROM price_manifests WHERE kind = 'backfill')
  AND mc.exception_reason IS NULL AND s.quality_status IS DISTINCT FROM 'complete'
ORDER BY 1 LIMIT 50;

SELECT i.code, count(p.date) AS rows, min(p.date), max(p.date)
FROM indices i LEFT JOIN index_prices_daily p ON p.index_id = i.id GROUP BY i.id ORDER BY i.code;

SELECT c.nse_symbol, count(*) AS unexplained_missing_sessions
FROM companies c JOIN price_series_state s ON s.company_id = c.id
JOIN trading_sessions t ON t.exchange = 'NSE'
 AND t.date BETWEEN greatest(s.desired_from, coalesce(c.listed_from, s.desired_from))
                AND least(s.desired_to, coalesce(c.delisted_on, s.desired_to))
LEFT JOIN prices_daily p ON p.company_id = c.id AND p.date = t.date
WHERE p.date IS NULL AND NOT EXISTS (
  SELECT 1 FROM price_gaps g WHERE g.series_id = s.id
   AND t.date BETWEEN g.from_date AND g.to_date AND g.status = 'exempt')
GROUP BY c.nse_symbol ORDER BY 2 DESC LIMIT 30;

SELECT c.nse_symbol, p.date, p.adjustment_generation, s.adjustment_generation
FROM prices_daily p JOIN price_series_state s ON s.company_id = p.company_id
JOIN companies c ON c.id = p.company_id
WHERE p.is_final AND (p.adjustment_generation <> s.adjustment_generation OR p.adj_close IS NULL)
LIMIT 30;

SELECT reason, status, count(*), sum(sessions) FROM price_gaps GROUP BY 1, 2 ORDER BY 3 DESC;
```

The mixed-generation query should return no rows and the gap list should be short and explained. Rows of an older generation can exist briefly during a rebuild, but the API never serves them.

API: `GET /api/v1/companies/{symbol}/prices` returns `{ bars, meta }` (previously a bare `{ bars }`). Each bar carries `adjClose` and `final`; provisional bars (today's, not yet final) are included and flagged with `final: false` (`meta.provisional = "flagged"`). Only bars of the series' current `adjustment_generation` are served. `meta` is read in the same statement and cache entry as the bars: `priceBasis`, `generation`, `quality`, `exceptionReason`, `finalThrough`, `verifiedThrough`, `openGaps`, `missingSessions`, `provisional`.

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

## Retention

`maintenance.prune` runs daily at 03:30 IST and deletes in batches of 1,000 rows per statement until a batch comes back short or the job is 30 s from its 10 min deadline (the next run continues). The windows live in `RETENTION` in `packages/jobs/src/maintenance.ts`.

| Data | Kept | Notes |
| --- | --- | --- |
| `job_runs` succeeded / failed, dead, abandoned | 14 d / 90 d | |
| `job_daily_stats` | 400 d | |
| `ops_alerts` resolved | 30 d | |
| `ingest_runs` succeeded / failed | 90 d / 180 d | Never `running` runs, never a campaign that still has queued, running or deferred `job_runs`, never the newest run per `(source, status)`. Deleting a campaign cascades to its `job_runs`. |
| `chokepoint_transits` open | 30 d | Then closed: `left_at = entered_at + loiter_min`, `ended_by = 'abandoned'`. |
| `chokepoint_transits` completed | 180 d | By `left_at`. |
| `altdata_events` | 180 d | By `occurred_at`. |
| `llm_usage` | 90 d | Whole UTC days, rolled into `llm_usage_daily` (calls, failures, token and latency sums per day, model and kind) in the same statement that deletes them. `llm_usage_daily` therefore holds only days whose raw rows are gone; recent days are read from `llm_usage`. |
| `insights` superseded | 180 d | By `superseded_at`; current insights are never pruned. |
| `consensus_history` | 5 y | By `month`. |
| `aircraft_flights`, `vessel_calls`, `altdata_coverage` | 400 d | |
| `aircraft_positions` / `vessel_positions` | 90 d / 30 d | Deleted by the separate `altdata.cleanup` job (08:20 IST), not by `maintenance.prune`. |
| pg-boss jobs | completed 48 h, failed 14 d | Set per queue by `deleteAfterSeconds` and the dead-letter retention in `packages/jobs/src/enqueue.ts`; pg-boss 12 has no separate archive table. |

None of the pruned tables is referenced by `evidence_spans` or `announcement_holds`.

## Announcement policy and one-off cleanup

Every announcement gets `category_key`, `retention_class` (`forever`, `five_years`, `noise`, `review_hold`), `retain_until` and `policy_version` from `packages/ingest/src/announcements/policy.ts` (`ANNOUNCEMENT_POLICY_VERSION`). The ingester drops `noise` rows at fetch time and rewrites the four columns of existing rows whose `policy_version` is older. An announcement is pinned while it has a row in `announcement_holds`, or while a document with `source` in (`announcement_metadata`, `order_filing`, `rating_rationale`) and `url` equal to `nse://announcement/<id>`, `nse://announcement/<id>/rating` or the announcement's `attachment_url` has evidence spans. Pinned rows are never deleted, and neither is any announcement that has such a linked document, cited or not: the document exists before any extraction (regex, cached or LLM) reads it, so the delete only has to see the document row. Each delete batch takes the `announcement_evidence` advisory lock exclusively while `writeExtraction` holds it shared, so a batch never commits between an extraction's checks and its evidence write. The one window left is an announcement past its retention date that a pipeline first reads in the same seconds a batch deletes it; the document and its evidence stay valid, only the NEWS row is gone. Pins found by the cleanup are recorded as `announcement_holds` rows with `reason = 'evidence'`, and the announcement is set to `review_hold`.

`maintenance.announcements` is a one-off chain with no schedule. Each step enqueues the next one only after it succeeds, so nothing is deleted until a verified backup exists:

1. `maintenance.announcements` records `max(id)`. Rows inserted later are never touched.
2. `.backup` writes every row up to that id as gzip NDJSON (`row_to_json`) to `s3://<ArchiveBucket>/backups/announcements-<YYYY-MM-DD>.ndjson.gz`, with `.enc` appended when it is encrypted. It then checks size and checksum with a `HEAD` request and records the object in `storage_objects` (`kind = 'backup'`; `documents.gc` never touches that kind).
3. `.classify` applies the current policy in batches of 5,000 ids. When it nears its deadline it defers itself and resumes.
4. `.delete` checks the S3 object against `storage_objects` again, and refuses to run if a single row up to the max id is still unclassified. It pins cited rows, then deletes `noise` rows, then rows whose `retain_until` has passed: 1,000 rows per transaction, a 10 s `statement_timeout`, and a 200 ms pause between batches. Every 10 batches it checks the table's dead tuples. When they are above twice the autovacuum trigger, it defers itself for 5 minutes so autovacuum can catch up. After deleting rows it invalidates the `announcements:` API cache.
5. `.reindex` drops any invalid leftover index, then runs `REINDEX INDEX CONCURRENTLY` on every announcement index from a reserved connection (no statement timeout, 30 s lock timeout). REINDEX needs the table owner, so in production (the tables are owned by `ma_migrator`) this step reports `denied` and counts `maintenance.reindex.denied`. Run it once by hand:

   ```bash
   psql "$MIGRATION_DATABASE_URL" -c 'reindex table concurrently announcements'
   ```

Run it and follow it:

```bash
pnpm --filter @ma/worker cli run maintenance.announcements
```

```sql
select job_type, status, attempt, metrics, left(error, 200) as error, finished_at
from job_runs where job_type like 'maintenance.announcements%' order by id desc limit 10;
```

`--wait` returns as soon as the first step has enqueued the backup. Because the delete and classify steps defer themselves, their final `metrics` only cover the last slice; the worker logs every slice (`announcement delete slice`). `metrics.remaining` and `metrics.bytes` on the final delete row, and `bytesBefore` / `bytesAfter` on the reindex row, show the row count and `pg_total_relation_size` after the cleanup. Deleted heap space is reused by later inserts, but the table file is not returned to the OS without `VACUUM FULL`.

`BACKUP_ENCRYPTION_KEY` (worker secret, 64 hex characters, `openssl rand -hex 32`) encrypts the backup with AES-256-GCM. The key is derived with HKDF-SHA256 (info `market-analysis/backup/v1`), and the file layout is `MABK1\n`, a 12-byte IV, a 16-byte tag, then the ciphertext. When the key is unset (SSM holds a single space), the backup is written unencrypted, the worker logs a warning and it counts `maintenance.backup.unencrypted`. Keep the key outside AWS as well; a lost key makes the backup unreadable.

Decrypt and restore (the key in `BACKUP_ENCRYPTION_KEY`; skip the decrypt step and use `gunzip` for an unencrypted backup):

```bash
aws s3 cp s3://<ArchiveBucket>/backups/announcements-<day>.ndjson.gz.enc backup.enc
node -e '
const c=require("node:crypto"),fs=require("node:fs"),z=require("node:zlib");
const b=fs.readFileSync(process.argv[1]),m=6;
const k=Buffer.from(c.hkdfSync("sha256",Buffer.from(process.env.BACKUP_ENCRYPTION_KEY,"hex"),Buffer.alloc(0),"market-analysis/backup/v1",32));
const d=c.createDecipheriv("aes-256-gcm",k,b.subarray(m,m+12));d.setAAD(b.subarray(0,m));d.setAuthTag(b.subarray(m+12,m+28));
process.stdout.write(z.gunzipSync(Buffer.concat([d.update(b.subarray(m+28)),d.final()])))' backup.enc > announcements.ndjson
psql "$MIGRATION_DATABASE_URL" <<'SQL'
create temp table restore_lines (line jsonb);
\copy restore_lines from 'announcements.ndjson' with (format csv, quote e'\x01', delimiter e'\x02')
insert into announcements select (jsonb_populate_record(null::announcements, line)).*
from restore_lines on conflict (id) do nothing;
SQL
```

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

1. `pnpm --filter @ma/worker cli mode paused` if the bad release is writing bad data.
2. Redeploy the previous task definition revision (the image is pinned by sha in each revision):

   ```bash
   aws ecs list-task-definitions --family-prefix market-analysis-worker --sort DESC --max-items 5
   aws ecs update-service --cluster market-analysis --service market-analysis-worker \
     --task-definition market-analysis-worker:<previous revision>
   aws ecs wait services-stable --cluster market-analysis --services market-analysis-worker
   ```

3. `cli mode worker` once the old version is running.

Migrations are additive (expand/contract), so the previous image runs against the new schema; never downgrade the schema by hand. The deployment circuit breaker already rolls back automatically when a new revision cannot reach a running state. The web cron routes answer 410 and the legacy runner no longer exists, so there is no web-side fallback: rollback is always a previous worker image.

## Cost

Expected ≈ $11/month on Spot (≈ $6–7 compute, ≈ $3.6 for the task's public IPv4 address, under $2 for S3, logs, metrics, alarms and ECR); ≈ $24 on on-demand Fargate, which exceeds the default $20 budget. Breakdown and assumptions in `infra/aws/README.md`. Check AWS Cost Explorer (service and usage type) a week after launch against this estimate.
