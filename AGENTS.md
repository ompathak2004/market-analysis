# market-analysis — agent context

Indian-equities intelligence terminal: Bloomberg-style supply-chain intelligence (SPLC), Moneycontrol broker research, a Cerebras-backed intelligence layer (company briefs, broker digests, market brief, filing triage), corporate-aircraft and vessel alt-data, and a Gloomberg-style terminal UI over NSE/BSE data. One Next.js app on Vercel serves the UI, the `/api/v1` read API and the cron jobs. Read this file first; it is the map. Keep it current when you change structure or conventions.

## Layout (pnpm workspace, TypeScript ESM, Node 22)

| Path | Package | Role |
| --- | --- | --- |
| `packages/core` | `@ma/core` | Zod-validated env `loadConfig()`, pino logger with bounded error serializer, `AppError`/`NotFoundError`/`UpstreamError`/`RateLimitedError`, `chunk`, `mapLimit`, `parseIndianNumber`, `addYears`. |
| `packages/db` | `@ma/db` | Drizzle schema (`src/schema.ts`), `createDb`/`closeDb`, migrations in `drizzle/`, re-exports Drizzle operators. |
| `packages/cache` | `@ma/cache` | `Cache` (L1 LRU + L2 Redis, stale-while-revalidate, single-flight, hit/miss metrics), `RateLimiter` (Redis token bucket). |
| `packages/llm` | `@ma/llm` | `LlmClient` for Cerebras (strict JSON-schema output, retries on 429/5xx, fallback model), `LlmBudget` (daily token budget in Redis), zod → JSON schema. |
| `packages/ingest` | `@ma/ingest` | `DocumentStore`, `HttpClient` (per-host token buckets), sources (NSE, Yahoo, Screener, Moneycontrol, Firecrawl, adsb.lol, OpenSky, AISStream, aircraft registry), extractors, pipelines (`universe`, `prices`, `fundamentals`, `announcements`, `relationships`, `research`, `aircraft`, `vessels`), reference data in `src/data/`, Firecrawl monthly credit budget, CLI. |
| `packages/intel` | `@ma/intel` | Estimates, momentum, DuPont distress, event-impact OLS (`src/*.ts`); rule insights, input assembly, hashing, prompts and LLM generators for company brief, broker digest, market brief, triage and broker thesis (`src/insights/`); travel and logistics alt-data signals (`src/altdata/`); CLI. |
| `packages/jobs` | `@ma/jobs` | Job contracts (type → lane, payload schema, unit key, deadline, retry limit), retry/deferral policies, `job_control` mode, consumer lease, `job_runs`/`job_attempts` ledger, campaigns, retention, cache invalidation map, `company_sync` batch picking (`pickBatch`, `markSynced`, shared by web and worker). `@ma/jobs/queue` holds the pg-boss enqueue/queue setup so web never loads pg-boss. |
| `apps/worker` | `@ma/worker` | Long-running pg-boss consumer (ECS Fargate): per-unit handlers (`src/handlers`), executor with ledger fencing (`src/execute.ts`), cron schedules in code (`src/schedules.ts`), CloudWatch metrics, CLI (`src/cli.ts`). |
| `apps/web` | `@ma/web` | Next.js 15 app: terminal UI (`src/app`, `src/components`), `/api/v1` route handlers (`src/app/api/v1`), `/api/cron/[job]` runner, `src/server/{context,http,jobs,queries}`. Server components call `@/server/queries` directly; no secrets reach the browser. |
| `docs/` | — | `methodology.md` (models), `plan.md` (status + next steps), `data-sources.md`. |

Dependency direction: `core ← db ← cache ← ingest ← intel ← web`, `core ← llm ← intel` and `core, db, cache ← jobs ← web, worker`; `worker` also uses `ingest`, `intel` and `llm`. Never import upward.

## Commands

```
pnpm install
pnpm db:migrate                 # applies packages/db/drizzle to DATABASE_URL
pnpm dev:web                    # UI + API + cron routes on :3000
pnpm typecheck && pnpm lint && pnpm test
pnpm build:web                  # builds packages then apps/web (what Vercel runs)
pnpm job <name> [budgetMs]      # legacy: run one web job once (only while job_control mode is legacy)
pnpm dev:worker                 # queue consumer from source (tsx)
pnpm build:worker               # builds packages then apps/worker (what the Docker image runs)
pnpm worker:cli run <type|legacy-name> [payload-json] [--wait]   # enqueue one job
pnpm worker:cli mode [legacy|paused|worker]                      # read or switch job_control
pnpm worker:cli status | schedules | types
pnpm exec tsx --conditions=@ma/source packages/ingest/src/cli.ts universe NIFTY50
pnpm exec tsx --conditions=@ma/source packages/intel/src/cli.ts momentum
```

Load env with `set -a && . ./.env && set +a`. Every package exports `"@ma/source": "./src/index.ts"` so `tsx --conditions=@ma/source` and vitest run from source; `pnpm build` emits `dist/` for the Next.js build.

## Jobs and cron

`job_control.mode` (singleton row, default `legacy`) decides who runs jobs:

- `legacy`: Vercel cron calls `GET /api/cron/<job>` (`Authorization: Bearer $CRON_SECRET`); `runJob` in `apps/web/src/server/jobs` takes a Redis lock, records `ingest_runs`, enforces a time budget and invalidates cache prefixes. The worker holds its lease but consumes nothing and clears its schedules.
- `paused`: nothing runs; web cron routes return `skipped/disabled`.
- `worker`: `apps/worker` consumes the pg-boss queues (schema `pgboss`) and registers the cron schedules in `src/schedules.ts` (`Asia/Kolkata`, `missed: "once"`); web cron routes are no-ops.

Worker model: every job type in `packages/jobs/src/contracts.ts` is either a `fanout` (picks stale units and enqueues children in one transaction, recorded as an `ingest_runs` campaign with `children_total/done/failed`) or a `unit` (one company, document or batch). Lanes `control, io, parse, compute, llm, cache` have fixed local concurrency (`LANE_CONCURRENCY`). Each logical unit is a `job_runs` row keyed by `(job_type, unit_key, campaign_id)` with one `job_attempts` row per try. Retries are app-managed with exponential backoff and Retry-After; LLM daily budget and Firecrawl monthly credit exhaustion defer to the next window without spending an attempt; non-retryable errors and exhausted retries go `dead`. A single consumer holds the `worker_leases` row `consumer`; every ledger write is fenced on the lease generation, and a new consumer marks prior running attempts `abandoned`. `ops.reconcile` (15 min) finishes campaigns, abandons overdue runs, raises `ops_alerts`; `ops.digest` emails a daily summary through Resend when `RESEND_API_KEY` and `OPS_DIGEST_TO` are set. With `CLOUDWATCH_METRICS=true` the worker publishes `worker.heartbeat` and `jobs.dead` (namespace `MarketAnalysis`) every minute. SIGTERM drains within 120 s.

Production runs the compiled CLI as `node apps/worker/dist/cli.js ...` (no tsx at runtime). Legacy job names (`prices`, `moneycontrol`, `broker-reports`, ...) are accepted as aliases by `worker:cli run`.

## Data model (Postgres, Drizzle)

Core: `companies` (NSE symbol is the natural key) → `company_aliases`, `company_sync`, `index_constituents`, `indices`, `index_prices_daily`, `prices_daily`, `fundamentals` (annual/quarterly, ₹ Cr), `announcements`, `analyst_calls` (`report_document_id`, `thesis`), `documents` (raw fetched text, `parser_version`, `status`), `relationships` (supplier→customer, `disclosure_kind`, `confidence`, `valid_from/to`) → `relationship_estimates` (`method` disclosed|derived|estimated, value + range, `model_version`), `signals` (`kind`, `as_of`, `value`, `inputs` jsonb), `ingest_runs`.

Prices (`packages/ingest/src/pipelines/prices.ts`, migration `0005_price_history`): one `price_series_state` row per company or index (exactly one owner) holds the desired five-year window, `verified_through`, `adjustment_generation`, `action_hash` and `quality_status` (pending|partial|complete|exception|rebuild_required). `prices_daily` / `index_prices_daily` rows carry `source`, `source_symbol`, `parser_version`, `adjustment_generation`, `is_final` (the bar's IST day has passed) and, for equities, `adjustment_status`. `trading_sessions` (exchange `NSE`) is the expected-session calendar, currently derived from ^NSEI dates. `price_gaps` stores coalesced missing ranges with a reason, `status` open|exempt|resolved and exponential `next_check_at`. `corporate_actions` (splits, dividends, keyed by `event_key`) and `market_symbols` (provider symbol validity) come from the Yahoo chart events and the `market-indices.ts` / universe registry. Rules: OHLC is split-adjusted, `adj_close` is split+dividend adjusted, index rows are price-return levels (`PRICE_BASIS` in `@ma/db`). A window write refuses a symbol the series does not own and a generation that is not current; a new or corrected corporate action marks the series `rebuild_required` instead of rescaling rows, and `prices.rebuild` refetches the whole window and moves every row to the next generation in one transaction. Replays compare floats with a 1e-5 relative tolerance (Yahoo recomputes `adj_close` per request). Readers (`loadCloses` in `@ma/intel`) use only final rows on the current generation with non-null `adj_close`.

Research (Moneycontrol): `shareholding`, `analyst_ratings`, `consensus_history`, `earnings_estimates`, `price_targets`, `earnings_surprises`, `company_facts`.

Intelligence: `insights` (`kind` company_brief|broker_digest|market_brief|announcement_triage, `inputs_hash`, `superseded_at`, `model_version`, validated JSON `output`), `llm_usage`.

Alt-data: `corporate_aircraft` → `corporate_aircraft_companies`, `aircraft_positions`, `aircraft_flights`; `facilities` → `facility_companies`; `vessels`, `vessel_positions`, `vessel_calls`, `chokepoint_transits`, `vessel_fleet`; `altdata_events`, `altdata_coverage`.

Signal kinds: `customer_concentration_pct`, `top{N}_customers_pct`, `customer_momentum_{1m,2m,3m}`, `supplier_momentum_{1m,2m,3m}`, `customer_hhi`, `distress_score`, `travel_*` and `logistics_*` (`packages/intel/src/altdata/types.ts`).

## Conventions

- No comments unless the *why* is non-obvious; no dead code; no TODO markers — put open work in `docs/plan.md`.
- Biome for lint/format (`pnpm lint:fix`). `exactOptionalPropertyTypes` is on: use `?? null`, not `undefined`, for nullable columns.
- Every external fetch goes through `IngestContext.http` (per-host token buckets in `HOST_LIMITS`) or `DocumentStore`; never `fetch` directly in pipelines. Firecrawl calls go through the monthly credit budget.
- Parsers carry a `*_PARSER_VERSION`/`*_EXTRACTOR_VERSION`; bump it when output changes so stale documents re-parse.
- Models carry a `*_MODEL_VERSION`; estimates, signals and insights are keyed by it so old rows stay comparable. LLM outputs are validated against the zod schemas in `packages/intel/src/insights`; every claim cites an evidence id from the prompt inputs, and a brief is regenerated only when its `inputs_hash` changes.
- Read models live in `apps/web/src/server/queries/*.ts` (`core`, `research`, `insights`, `altdata`, `screens`), are cached through `ctx.api` with explicit `ttlMs/staleMs`, and are shared by the route handlers and the server components; jobs invalidate prefixes after writes. Web code imports workspace packages by name and local modules without a `.js` suffix.
- Web UI: routes in `src/app` (`/`, `/c/[symbol]/[tab]`, `/signals`, `/movers`, `/help`) compose panes from `src/components/panes/**`, which call read models through `attempt()` so one failing pane renders `DATA UNAVAILABLE` instead of failing the page. Primitives live in `src/components/ui`, shell chrome in `src/components/shell`, keyboard handling in `src/lib/keymap`. Styles are plain CSS in `src/styles` (`tokens.css` holds every colour/size; panes place themselves with the `--area` custom property into `grid.css` layouts). Function codes: DES, GP, FA, ANR, SPLC, NEWS, JET, SHIP, INTL. Every page must fit 1440×900 with no document scroll; panes scroll internally with the custom scrollbar.
- Commits: conventional (`feat(scope): …`), small, one concern each. `.env` is gitignored (GitHub push protection rejects the Aiven password); `.env.example` is the contract.

## Secrets and services

`DATABASE_URL` (Aiven Postgres), `REDIS_URL` (managed Redis), `API_KEY` (`x-api-key` for `/api/v1`; only `/api/v1/search` is public, rate-limited per IP), `CRON_SECRET` (bearer for `/api/cron`), `FIRECRAWL_API_KEY`, `CEREBRAS_API_KEY`, `AISSTREAM_API_KEY`, `OPENSKY_CLIENT_ID`/`OPENSKY_CLIENT_SECRET`. See `.env.example`.
