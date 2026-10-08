# Plan and status

Handoff document. Update the status table and the "Next" list at the end of every working session.

## Goal

A Bloomberg-like terminal for Indian equities with a genuine intelligence layer: supply-chain relationships extracted from filings, value estimation, customer momentum, distress scoring, event impact analysis, and aggregated broker calls — served through a fast cached API and a keyboard-driven terminal UI.

## Status

| Milestone | State | Where |
| --- | --- | --- |
| Monorepo, config, logger, Drizzle schema + migration `0000_init` | done | `main` |
| Two-tier cache (LRU + Redis, SWR, single-flight) and rate limiter | done | `main` |
| Ingest: document store, NSE/Yahoo/Screener sources (Trendlyne since replaced by Moneycontrol), pipelines, relationship extractor | done | PR #1 `vorflux/ingest` |
| Intel: estimates, momentum, distress, event impact | done | PR #2 `vorflux/intel` |
| Fastify API + scheduler worker | done | PR #3 `vorflux/server` |
| Next.js terminal UI (home, DES/GP/FA/ANR/SPLC/NEWS, command bar) | done | PR #4 `vorflux/web` |
| Docker images + compose, AGENTS.md, docs | done | PR #5 |
| Vercel deployment of `apps/web` | pending | needs public API URL |
| Widen data: NIFTY500 prices/fundamentals/relationships | partial | run worker jobs |

PRs are stacked: merge #1 → #2 → #3 → #4 → #5 in order.

## Data currently loaded (Aiven Postgres)

NIFTY50 + NIFTY500 universes with aliases; 2y daily prices for NIFTY50, HEROMOTOCO, ENDURANCE; fundamentals for NIFTY50 + SONACOMS/HEROMOTOCO/ENDURANCE; RELIANCE announcements; ~10 broker calls; relationship documents for SONACOMS and ENDURANCE; signals: concentration (SONACOMS), momentum (ENDURANCE↔HEROMOTOCO), distress for 42 non-financials.

## Runbook

```
set -a && . ./.env && set +a
pnpm db:migrate
W="pnpm exec tsx --conditions=@ma/source apps/server/src/worker/main.ts"
$W universe        # indices + companies + aliases (daily)
$W prices          # 1mo bars for the universe (4h, IST market hours)
$W fundamentals    # 40 stalest companies per run (hourly)
$W moneycontrol    # 10 stalest INTEL_UNIVERSE companies: page, SWOT, estimates (30m)
$W broker-reports  # 12 unfetched broker report PDFs (15m)
$W announcements   # NSE (2h)
$W relationships   # 15 stalest non-financials: 2 ARs + 4 concalls (6h)
$W intel           # estimates → momentum → risk (12h)
```

Run without arguments to start the scheduler with all jobs. Redis locks make it safe to run several workers.

## Next

1. **Broker report theses**: `broker-reports` stores report PDFs and links them through `analyst_calls.report_document_id`; summarise that text into `analyst_calls.thesis` and show it in the ANR pane in place of the missing headline.
2. **Backfill**: `prices` for NIFTY500 (`cli.ts prices NIFTY500`), then `fundamentals` and `relationships` jobs repeatedly until `documents.fetched_at` is fresh for the universe; re-run `intel`.
3. **Host the API permanently**: `apps/web` is deployed on Vercel (project `market-analysis`, https://market-analysis-liard.vercel.app) with `API_URL`/`API_KEY` env vars; `API_URL` currently points at a temporary tunnel to the development sandbox. Run `docker compose up api worker` on a VM or container host and update `API_URL` (`vercel env add API_URL production`).
4. **Relationship recall**: add a sentence classifier (small LLM or fine-tuned model) behind `extractNamedMentions` to catch mentions without lexical cues; keep the regex path as a fast pre-filter.
5. **BSE announcements** as a second filings source; **NSE corporate actions**.
6. **Watchlists and alerts**: user-defined lists in the UI, notify on new analyst calls and signal threshold crossings.
7. **Auth for the web app** when exposing it publicly (currently the API key is the only gate).
8. **Observability**: `/v1/cache/metrics` exists; add request timing histograms and `ingest_runs` dashboards.
