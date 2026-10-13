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
| Job platform: `@ma/jobs` contracts/ledger/lease, migration `0003_jobs_platform`, pg-boss worker with per-unit handlers, schedules, CloudWatch metrics, CLI; web cron gated by `job_control` | done (not yet cut over; mode `legacy`) | `packages/jobs`, `apps/worker` |
| AWS deploy: ECS Fargate Spot worker, SSM secrets, alarms | in progress | `Dockerfile`, `infra/aws`, `docs/ops.md` |
| Five-year price history: series state, generations, gaps, corporate actions, NSE calendar, seven indices, worker backfill/daily/repair/rebuild jobs, finalized adjusted-close returns (momentum v2) | done (backfill not yet run in production) | `packages/ingest/src/pipelines/prices.ts`, `apps/worker/src/handlers/prices.ts`, `packages/intel/src/prices.ts` |

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

`pnpm job <name> [budgetMs]` runs one job once with the same lock, run record and cache invalidation as the cron route. On Vercel each job is triggered by `vercel.json` through `GET /api/cron/<job>` with `Authorization: Bearer $CRON_SECRET`.

## Next

0. **Worker cutover**: deploy the ECS worker, run `pnpm worker:cli mode worker`, watch `pnpm worker:cli status`, `ops_alerts` and the CloudWatch alarms for 48 h, then remove the `vercel.json` crons.
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
2. **Alt-data coverage**: Indian port geofences see almost no AISStream traffic; measure `altdata_coverage` over 24–72 h and either widen the watched zones or gate the SHIP pane on a coverage threshold. Jets depend on `aircraft-registry` links, which are provisional until confirmed from filings.
3. **Relationship recall**: add a sentence classifier behind `extractNamedMentions` to catch mentions without lexical cues; keep the regex path as a fast pre-filter.
4. **BSE announcements** as a second filings source; **NSE corporate actions**.
5. **Watchlists and alerts**: user-defined lists in the UI, notify on new analyst calls, signal threshold crossings and verdict changes.
6. **Auth for the web app** when exposing it publicly (currently the API key is the only gate on `/api/v1`; pages are open).
7. **Observability**: `/api/v1/cache/metrics` reports cache, Firecrawl credit and LLM token budgets; add request timing histograms and `ingest_runs` dashboards.
8. **JET routes map**: the routes pane draws a hub-and-spoke schematic because airports have no coordinates in the schema. Add an ICAO → lat/lon table and switch `RoutesPane` to `MiniMap`.
9. **Terminal font glyphs**: the bundled JetBrains Mono subset lacks ₹ and ↵; they fall back to system fonts. Rebuild the woff2 subset with those code points.
10. **CSS specificity**: Biome reports 10 `noDescendingSpecificity` warnings in `styles/{charts,controls,pane,table}.css`; reorder selectors when those files are next touched.
