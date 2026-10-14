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
| Vercel-only platform: `/api/v1` route handlers, `/api/cron/[job]` runner, `vercel.json` crons | done | `apps/web/src/server` |
| Moneycontrol research: shareholding, ratings, consensus, estimates, targets, surprises, broker report PDFs | done | `packages/ingest/src/sources/moneycontrol.ts`, `pipelines/research.ts` |
| Cerebras intelligence layer: rule insights, company brief, broker digest, market brief, triage, broker theses | done | `packages/llm`, `packages/intel/src/insights` |
| Alt-data: aircraft registry + adsb.lol/OpenSky sampling, AISStream collection, travel and logistics signals | done | `packages/ingest/src/altdata`, `packages/intel/src/altdata` |
| Gloomberg-style terminal UI (home, DES/GP/FA/ANR/SPLC/NEWS/JET/SHIP/INTL, SIG, MOV, custom scrollbars) | done | `apps/web/src/{app,components,styles}` |
| Vercel deployment with crons against Aiven Postgres + managed Redis | in progress | project `market-analysis` |
| Widen data: NIFTY500 prices/fundamentals/relationships | partial | run jobs repeatedly |
| Job platform: `@ma/jobs` contracts/ledger/lease, migration `0003_jobs_platform`, pg-boss worker with per-unit handlers, schedules, CloudWatch metrics, CLI; web cron gated by `job_control` | done (cut over 2026-10-13; mode `worker`, Vercel crons removed) | `packages/jobs`, `apps/worker` |
| AWS deploy: ECS Fargate Spot worker, SSM secrets, alarms | in progress | `Dockerfile`, `infra/aws`, `docs/ops.md` |
| Five-year price history: series state, generations, gaps, corporate actions, NSE calendar, seven indices, worker backfill/daily/repair/rebuild jobs, finalized adjusted-close returns (momentum v2) | done (backfill not yet run in production) | `packages/ingest/src/pipelines/prices.ts`, `apps/worker/src/handlers/prices.ts`, `packages/intel/src/prices.ts` |
| Announcement retention policy v1 (`category_key`, `retention_class`, `retain_until`, `announcement_holds`, noise dropped at ingest), one-off `maintenance.announcements` backup/classify/delete/reindex chain, `maintenance.prune` retention for campaigns, transits, alt-data events and facts, `llm_usage` with `llm_usage_daily` rollup, insights, consensus history; migration `0009_announcement_policy` | done (cleanup not yet run in production) | `packages/ingest/src/announcements`, `packages/jobs/src/maintenance.ts`, `apps/worker/src/handlers/maintenance.ts`, `docs/ops.md` |
| Supply chain v3: counterparties and aliases, matcher v3 (clause splitting, cue classes, peer/same-group/self rejection), extraction ledger with observations, evidence spans and edge materialization, order-win filings (regex), worker jobs `relationships.counterparties`, `relationships.rebuild`, `orders.fanout`, `orders.extract` | partial (rebuild not yet run) | `packages/ingest/src/{extract,relationships}`, `packages/ingest/src/pipelines/{relationships,orders}.ts`, `apps/worker/src/handlers/relationships.ts` |
| SPLC LLM and estimates v2: per-class LLM budgets (`relationships` 200k, `insights` 500k, `influence` 100k of 800k/day), grounded LLM extraction for unparsed order filings, annual reports, concalls, credit-rating rationales and investor presentations (pilot), rating-rationale source, estimates v2 with sector priors and aggregate caps, concentration v3, active signal versions; jobs `relationships.llm`, `relationships.llm.extract`, `relationships.priors`, `ratings.fanout/sync`, `presentations.fanout/sync` | done (not yet run in production) | `packages/llm/src/budget.ts`, `packages/intel/src/relationships`, `packages/intel/src/{estimates,priors,concentration,signal-versions}.ts`, `packages/ingest/src/{sources,pipelines}/ratings.ts`, `packages/ingest/src/pipelines/presentations.ts`, `apps/worker/src/handlers/relationships-llm.ts` |
| INFL political and policy layer: Sansad offices, MyNeta affidavits, SBI electoral bonds, PIB/PRS/eGazette policy events, NSE-industry sector map, rule-first policy tagging with an LLM fallback, documented political paths, influence review queue at `/admin/review`; jobs `influence.parliament`, `influence.affidavits` → `influence.affidavit`, `influence.bonds` (manual), `influence.sectors`, `influence.policy.{pib,prs,gazette}`, `influence.policy.tag` → `influence.policy.tag.event` | done (not yet run in production) | `packages/ingest/src/sources/{parliament,myneta,eci-bonds,pib,prs,egazette,policy-doc}.ts`, `packages/ingest/src/data/policy-sectors.ts`, `packages/intel/src/influence/{politics,policy,events,politics-sync,policy-sync}.ts`, `apps/worker/src/handlers/influence.ts`, `apps/web/src/server/queries/influence-reviews.ts` |

## Runbook

```
set -a && . ./.env && set +a
pnpm db:migrate
pnpm job universe           # indices + companies + aliases (daily)
pnpm job prices             # stalest companies, one series window each; full history comes from the worker `prices.backfill`
pnpm job fundamentals       # 40 stalest companies per run (hourly)
pnpm job announcements      # NSE (10 min)
pnpm job relationships      # 15 stalest non-financials: 2 ARs + 4 concalls
pnpm job intel              # estimates → momentum → risk (twice daily)
pnpm job moneycontrol       # 10 stalest INTEL_UNIVERSE companies: research pages, estimates
pnpm job broker-reports     # 12 unfetched broker report PDFs
pnpm job insights           # company briefs + broker digests whose inputs changed
pnpm job broker-theses      # summarise fetched broker reports into analyst_calls.thesis
pnpm job market-brief       # pre-open and post-close market read
pnpm job triage             # classify new announcements
pnpm job aircraft-registry  # seed corporate aircraft and link to companies
pnpm job aircraft-sample    # sample positions from adsb.lol / OpenSky
pnpm job ais-collect        # AISStream burst over watched zones
pnpm job altdata-derive     # legs, calls, transits from positions
pnpm job altdata-signals    # travel + logistics signals
pnpm job fleets             # owned-vessel fleets from filings
pnpm job altdata-cleanup    # retention
```

Worker equivalents (after `pnpm build:worker`): `pnpm worker:cli run prices --wait`, `pnpm worker:cli mode worker`, `pnpm worker:cli status`. Cutover: deploy the worker, `mode paused`, let in-flight web runs finish, `mode worker`; roll back with `mode legacy`.

`pnpm job <name> [budgetMs]` runs one job once with the same lock, run record and cache invalidation as the cron route. `GET /api/cron/<job>` (`Authorization: Bearer $CRON_SECRET`) still exists for manual legacy runs; `vercel.json` no longer schedules it.

## Next

0. **Worker cutover** (done 2026-10-13): the ECS worker runs every schedule; `vercel.json` has no crons. Gate still open: 24 h with no `running` row older than 15 min and the heartbeat alarm green, then point the Vercel `DATABASE_URL` at `ma_web`. Roll back with `pnpm worker:cli mode legacy` plus a redeploy of the crons.
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
1c. **Supply-chain rebuild**: run `pnpm --filter @ma/worker cli run relationships.counterparties --wait`, then `relationships.rebuild`, which re-reads every stored annual report, concall and screener page plus the documents cited by legacy edges; `orders.fanout` works through order-win filings daily. Legacy rows (`status='legacy'`) stay in place and the SPLC pane reads only `active` and `expired` edges; delete them with an archive receipt in a later maintenance step once the precision gate passes on the rebuilt graph. `packages/intel` `loadSupplyChain` still reads every status. After the rebuild, `relationships.llm` (05:00 IST) spends the `relationships` LLM budget on stored annual reports, concalls, rating rationales and the order filings the regex could not parse, and `relationships.priors` (Sundays) needs at least 20 disclosed revenue shares from 5 suppliers per sector and cost bucket before statistical estimates carry a value. Still open: populate `relationship_financial_facts` (purchases) from annual-report notes; turn on `SPLC_PRESENTATIONS_PILOT` once the precision of presentation observations has been reviewed; extend the announcement retention hold to `rating_rationale` documents.
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
