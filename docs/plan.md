# Plan and status

Handoff document. Update the status table and the "Next" list at the end of every working session.

## Goal

A Bloomberg-like terminal for Indian equities with a genuine intelligence layer: supply-chain relationships extracted from filings, value estimation, customer momentum, distress scoring, event impact analysis, Moneycontrol broker research, LLM-generated company and market briefs with cited evidence, and corporate-aircraft and vessel alt-data — served from one Next.js app on Vercel with a keyboard-driven terminal UI.

## Status

| Milestone | State | Where |
| --- | --- | --- |
| Monorepo, config, logger, Drizzle schema, migrations `0000_init` and `0001_platform` | done | `main` |
| Two-tier cache (LRU + Redis, SWR, single-flight) and rate limiter | done | `main` |
| Ingest: document store, NSE/Yahoo/Screener sources, pipelines, relationship extractor | done | `main` |
| Intel: estimates, momentum, distress, event impact | done | `main` |
| Web platform: `/api/v1` route handlers, read models, admin ops summary; the legacy `/api/cron/[job]` runner is retired (410) | done | `apps/web/src/server` |
| Moneycontrol research: shareholding, ratings, consensus, estimates, targets, surprises, broker report PDFs | done | `packages/ingest/src/sources/moneycontrol.ts`, `pipelines/research.ts` |
| Cerebras intelligence layer: rule insights, company brief, broker digest, market brief, triage, broker theses | done | `packages/llm`, `packages/intel/src/insights` |
| Alt-data: aircraft registry + adsb.lol/OpenSky sampling, AISStream collection, travel and logistics signals | done | `packages/ingest/src/altdata`, `packages/intel/src/altdata` |
| Gloomberg-style terminal UI (home, DES/GP/FA/ANR/SPLC/NEWS/JET/SHIP/INTL, SIG, MOV, custom scrollbars) | done | `apps/web/src/{app,components,styles}` |
| Vercel deployment (read-only web app) against Aiven Postgres + managed Redis | in progress (move `DATABASE_URL` to `ma_web`, drop `CRON_SECRET`) | project `market-analysis` |
| Widen data: NIFTY500 prices/fundamentals/relationships | partial | run jobs repeatedly |
| Job platform: `@ma/jobs` contracts/ledger/lease, migrations `0003_jobs_platform` and `0011_job_mode_worker_only`, pg-boss worker with per-unit handlers, schedules, CloudWatch metrics, CLI; `job_control` is `paused|worker` only | done (cut over 2026-10-13; mode `worker`, Vercel crons and the web runner removed) | `packages/jobs`, `apps/worker` |
| AWS deploy: ECS Fargate Spot worker, SSM secrets, alarms | in progress | `Dockerfile`, `infra/aws`, `docs/ops.md` |
| Five-year price history: series state, generations, gaps, corporate actions, NSE calendar, seven indices, worker backfill/daily/repair/rebuild jobs, finalized adjusted-close returns (momentum v2) | done (backfill not yet run in production) | `packages/ingest/src/pipelines/prices.ts`, `apps/worker/src/handlers/prices.ts`, `packages/intel/src/prices.ts` |
| Announcement retention policy v1 (`category_key`, `retention_class`, `retain_until`, `announcement_holds`, noise dropped at ingest), one-off `maintenance.announcements` backup/classify/delete/reindex chain, `maintenance.prune` retention for campaigns, transits, alt-data events and facts, `llm_usage` with `llm_usage_daily` rollup, insights, consensus history; migration `0009_announcement_policy` | done (cleanup not yet run in production) | `packages/ingest/src/announcements`, `packages/jobs/src/maintenance.ts`, `apps/worker/src/handlers/maintenance.ts`, `docs/ops.md` |
| Supply chain v3: counterparties and aliases, matcher v3 (clause splitting, cue classes, peer/same-group/self rejection), extraction ledger with observations, evidence spans and edge materialization, order-win filings (regex), worker jobs `relationships.counterparties`, `relationships.rebuild`, `orders.fanout`, `orders.extract` | partial (rebuild not yet run) | `packages/ingest/src/{extract,relationships}`, `packages/ingest/src/pipelines/{relationships,orders}.ts`, `apps/worker/src/handlers/relationships.ts` |
| SPLC LLM and estimates v2: per-class LLM budgets (`relationships` 200k, `insights` 500k, `influence` 100k of 800k/day), grounded LLM extraction for unparsed order filings, annual reports, concalls, credit-rating rationales and investor presentations (pilot), rating-rationale source, estimates v2 with sector priors and aggregate caps, concentration v3, active signal versions; jobs `relationships.llm`, `relationships.llm.extract`, `relationships.priors`, `ratings.fanout/sync`, `presentations.fanout/sync` | done (not yet run in production) | `packages/llm/src/budget.ts`, `packages/intel/src/relationships`, `packages/intel/src/{estimates,priors,concentration,signal-versions}.ts`, `packages/ingest/src/{sources,pipelines}/ratings.ts`, `packages/ingest/src/pipelines/presentations.ts`, `apps/worker/src/handlers/relationships-llm.ts` |
| INFL political and policy layer: Sansad offices, MyNeta affidavits, SBI electoral bonds, PIB/PRS/eGazette policy events, NSE-industry sector map, rule-first policy tagging with an LLM fallback, documented political paths, influence review queue at `/admin/review`; jobs `influence.parliament`, `influence.affidavits` → `influence.affidavit`, `influence.bonds` (manual), `influence.sectors`, `influence.policy.{pib,prs,gazette}`, `influence.policy.tag` → `influence.policy.tag.event` | done (not yet run in production) | `packages/ingest/src/sources/{parliament,myneta,eci-bonds,pib,prs,egazette,policy-doc}.ts`, `packages/ingest/src/data/policy-sectors.ts`, `packages/intel/src/influence/{politics,policy,events,politics-sync,policy-sync}.ts`, `apps/worker/src/handlers/influence.ts`, `apps/web/src/server/queries/influence-reviews.ts` |

## Runbook

```
set -a && . ./.env && set +a
pnpm build && pnpm db:migrate
pnpm worker:cli mode worker
pnpm worker:cli run universe --wait        # indices + companies + aliases (daily)
pnpm worker:cli run prices.backfill --wait # five-year history, once; prices.daily keeps it current
pnpm worker:cli run fundamentals           # 40 stalest companies per fan-out (hourly)
pnpm worker:cli run announcements          # NSE (10 min)
pnpm worker:cli run relationships          # stalest non-financials: annual reports + concalls
pnpm worker:cli run intel                  # estimates → momentum → risk (twice daily)
pnpm worker:cli run moneycontrol           # stalest INTEL_UNIVERSE companies: research pages, estimates
pnpm worker:cli run broker-reports         # unfetched broker report PDFs
pnpm worker:cli run insights               # company briefs + broker digests whose inputs changed
pnpm worker:cli run broker-theses          # summarise fetched broker reports into analyst_calls.thesis
pnpm worker:cli run market-brief           # pre-open and post-close market read
pnpm worker:cli run triage                 # classify new announcements
pnpm worker:cli run aircraft-registry      # seed corporate aircraft and link to companies
pnpm worker:cli run aircraft-sample        # sample positions from adsb.lol / OpenSky
pnpm worker:cli run ais-collect            # AISStream burst over watched zones
pnpm worker:cli run altdata-derive         # legs, calls, transits from positions
pnpm worker:cli run altdata-signals        # travel + logistics signals
pnpm worker:cli run fleets                 # owned-vessel fleets from filings
pnpm worker:cli run altdata-cleanup        # retention
pnpm worker:cli status | schedules | types
```

Every name above is a family alias for a worker job type (`pnpm worker:cli types` lists them); `--wait` polls the ledger until the fan-out and its children finish. Production runs the same commands inside the task as `node dist/cli.js ...` (`docs/ops.md`). The web app runs nothing: `/api/cron/<job>` answers 410 and `GET /api/v1/ops/jobs` is the read-only ledger summary.

## Next

0. **Worker cutover** (done 2026-10-13): the ECS worker runs every schedule; `vercel.json` has no crons and the web runner is gone, so the only rollback is a previous worker image (`docs/ops.md`, "Rollback"). Still open, in order: scale the worker to 0 and apply migrations `0007`–`0011` with `ma_migrator` in one window (drizzle runs the batch in one transaction, so `0009` holds its `announcements` locks and `0008` its `insights_key_uq` lock until the whole batch commits; first run `select company_id, kind, subject_id, model_version, input_hash, count(*) from insights group by 1,2,3,4,5 having count(*) > 1` and delete duplicates, or `0008` fails) (the CI workflow does this once `infra/aws/github-workflow-worker.yml` is copied to `.github/workflows/worker.yml` with a `workflow`-scoped token; the running image predates this branch), redeploy the worker, add `LLM_BUDGET_*`, `SPLC_PRESENTATIONS_PILOT`, `BACKUP_ENCRYPTION_KEY` and `OPS_DIGEST_TO` to SSM, confirm the startup log shows `ma_worker` with a bounded `statement_timeout`, then after 24 h with no `running` row older than 15 min and the heartbeat alarm green point the Vercel `DATABASE_URL` at `ma_web`, remove `CRON_SECRET` from the Vercel env and rotate `API_KEY`.
1. **Backfill**: run `pnpm --filter @ma/worker cli run prices.backfill --wait` once (see `docs/ops.md`, "Price history"), then `prices.repair` until the acceptance queries are clean; run `fundamentals`, `relationships` and `moneycontrol` repeatedly until `company_sync` is fresh for `DATA_UNIVERSE`; then `intel` and `insights`. `index_prices_daily` must be populated for the market brief breadth and sector sections.
1a. **Price history follow-ups**:
   - Import NSE holiday notices into `trading_sessions` so the calendar does not depend on ^NSEI having a bar for every session.
   - Verify the NSE equity history fallback from an Indian egress; from the build host NSE answers with a 200 HTML region block, so only the index fallback is verified.
   - Stage rebuilds in a side table and swap generations, instead of one transaction over ~1,250 rows per series.
   - Monthly rotating full-source reconciliation of finalized history (today the daily repair reconciles stored rows against the calendar and refetches only open gaps; the daily job rereads the last ten sessions).
   - Archive raw provider payloads; none are kept today.
   - A CLI or admin path to clear an `identity_mismatch` series exception once `market_symbols` is fixed; today it is a manual `update price_series_state set exception_reason = null, quality_status = 'pending'`.
   - Record which calendar windows were fetched instead of inferring calendar coverage from session spacing (a hole of 7 days or less in an unfetched stretch is not detected).
   - Prune old `price_manifests` once the cutover acceptance is signed off.
   - Model rights issues, demergers and other non-split/dividend actions as documented exceptions.
1b. **Announcement cleanup**: set `BACKUP_ENCRYPTION_KEY` in SSM, run `pnpm --filter @ma/worker cli run maintenance.announcements`, confirm the backup object under `backups/` before the delete step runs, then run the reindex as the table owner (see `docs/ops.md`, "Announcement policy and one-off cleanup"). Expected: about −237k of 514k rows and about −160 MiB once the indexes are rebuilt and autovacuum has run. Sample the production subject vocabulary (`select subject, count(*) from announcements group by 1 order by 2 desc limit 300`) before the run and extend `policy.ts` if large groups fall into `other`.
1c. **Supply-chain rebuild**: run `pnpm --filter @ma/worker cli run relationships.counterparties --wait`, then `relationships.rebuild`, which re-reads every stored annual report, concall and screener page plus the documents cited by legacy edges; `orders.fanout` works through order-win filings daily. Legacy rows (`status='legacy'`) stay in place; the SPLC pane and `loadSupplyChain` (company briefs) read only `active` and `expired` edges and the momentum and concentration signals only `active` ones, so nothing cites a legacy edge. Delete them with an archive receipt in a later maintenance step once the precision gate passes on the rebuilt graph. `relationships.rebuild` enqueues one `relationships.extract` child per company with stored SPLC documents or legacy edges (bounded by the universe, batched by `enqueueChildren`); it is a one-off campaign, not a schedule. After the rebuild, `relationships.llm` (05:00 IST) spends the `relationships` LLM budget on stored annual reports, concalls, rating rationales and the order filings the regex could not parse, and `relationships.priors` (Sundays) needs at least 20 disclosed revenue shares from 5 suppliers per sector and cost bucket before statistical estimates carry a value. Precision gate before the legacy delete: draw a frozen sample with `pnpm --filter @ma/worker cli run relationships.sample '{"name":"gate-2026-10","size":100}' --wait`, decide every item at `/admin/review?sample=gate-2026-10`, then read `GET /api/v1/admin/relationships/precision?sample=gate-2026-10`; it passes only when all items are decided and the Wilson 95 % lower bound reaches 0.9, which for 100 items takes 96 confirmations (see `docs/ops.md`, "SPLC precision gate"). `relationships.facts.fanout` (Sundays 01:00 IST, alias `facts`) fills `relationship_financial_facts` with revenue, purchases (materials consumed plus stock-in-trade bought), COGS, capex and R&D from the statements of stored annual reports, so purchase shares divide by purchases; run it after the rebuild and check `select metric, count(*) from relationship_financial_facts group by 1`. Annual reports whose statements it cannot read (no "for the year ended" heading with a readable date, no unit header, tables whose values sit far from their labels, or a label without a fiscal year) stay pending and are retried every week; SG&A is not parsed. `supplyChain` resolves evidence for every listed edge in one batched pass (`picked` → `obs` → `spans` CTEs in `apps/web/src/server/queries/core.ts`). Still open: turn on `SPLC_PRESENTATIONS_PILOT` once a precision sample drawn with `family: "presentation"` passes the gate.
1d. **INFL political and policy follow-ups**:
   - First run: `influence.parliament`, then `influence.affidavits` and `influence.sectors`; run `influence.bonds '{"purchaseUrls":[...],"redemptionUrls":[...]}'` once with the SBI `EB_Purchase_Details` and `EB_Redemption_Details` PDF URLs; then work the pending edges at `/admin/review`.
   - `influence_coverage` has no parliament or MyNeta read timestamp; the pane derives the parliament read from `influence_extractions` and shows the affidavit read as unknown. Add both columns.
   - `@ma/db` does not re-export `notInArray`; the sector seeder uses `not (inArray(...))`.
   - Sansad gives no ministerial portfolio or term dates; find a source for portfolios and swearing-in dates.
   - The Rajya Sabha Register of Members' Interests is not published openly; MyNeta `rajsab09aff` is the proxy and has no affidavit PDF link.
   - eGazette: incomplete TLS chain (`UNABLE_TO_VERIFY_LEAF_SIGNATURE`) and WebForms `RecentUploads.aspx` postbacks that redirect to `error.aspx`; add the intermediate certificate to the trust store and a listing parser, then let `influence.policy.gazette` discover PDFs itself.
   - ECI's bond disclosure page returns 406 from its WAF; bond PDFs are passed by hand.
   - Map sectors from annual-report segment notes as a second source next to the NSE industry.
2. **Alt-data coverage**: Indian port geofences see almost no AISStream traffic; measure `altdata_coverage` over 24–72 h and either widen the watched zones or gate the SHIP pane on a coverage threshold. Jets depend on `aircraft-registry` links, which are provisional until confirmed from filings.
3. **Relationship recall**: add a sentence classifier behind `extractNamedMentions` to catch mentions without lexical cues; keep the regex path as a fast pre-filter.
4. **BSE announcements** as a second filings source; **NSE corporate actions**.
5. **Watchlists and alerts**: user-defined lists in the UI, notify on new analyst calls, signal threshold crossings and verdict changes.
6. **Auth for the web app** when exposing it publicly (currently the API key is the only gate on `/api/v1`; pages are open).
7. **Observability**: `/api/v1/cache/metrics` reports cache, Firecrawl credit and LLM token budgets; add request timing histograms and `ingest_runs` dashboards.
8. **JET routes map**: the routes pane draws a hub-and-spoke schematic because airports have no coordinates in the schema. Add an ICAO → lat/lon table and switch `RoutesPane` to `MiniMap`.
9. **Terminal font glyphs**: the bundled JetBrains Mono subset lacks ₹ and ↵; they fall back to system fonts. Rebuild the woff2 subset with those code points.
10. **CSS specificity**: Biome reports 10 `noDescendingSpecificity` warnings in `styles/{charts,controls,pane,table}.css`; reorder selectors when those files are next touched.
