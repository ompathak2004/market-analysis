# market-analysis — agent context

Indian-equities intelligence terminal: Bloomberg-style supply-chain intelligence (SPLC), broker call aggregation and a terminal UI, over NSE/BSE data. Read this file first; it is the map. Keep it current when you change structure or conventions.

## Layout (pnpm workspace, TypeScript ESM, Node 22)

| Path | Package | Role |
| --- | --- | --- |
| `packages/core` | `@ma/core` | Zod-validated env `loadConfig()`, pino logger with bounded error serializer, `AppError`/`NotFoundError`/`UpstreamError`/`RateLimitedError`, `chunk`, `mapLimit`, `parseIndianNumber`, `addYears`. |
| `packages/db` | `@ma/db` | Drizzle schema (`src/schema.ts`), `createDb`, migrations in `drizzle/`, re-exports Drizzle operators. |
| `packages/cache` | `@ma/cache` | `Cache` (L1 LRU + L2 Redis, stale-while-revalidate, single-flight, hit/miss metrics), `RateLimiter` (Redis token bucket). |
| `packages/ingest` | `@ma/ingest` | `DocumentStore`, sources (NSE, Yahoo, Screener, Moneycontrol, Firecrawl), extractors, pipelines, `IngestContext`, CLI. |
| `packages/intel` | `@ma/intel` | Estimates, momentum, DuPont distress, event-impact OLS, CLI. |
| `apps/server` | `@ma/server` | Fastify API (`src/app.ts`, `src/queries.ts`) and scheduler worker (`src/worker`). |
| `apps/web` | `@ma/web` | Next.js 15 terminal UI. Server components call the API with `API_KEY`; the browser never sees it. |
| `docker/`, `docker-compose.yml` | — | Images for api/worker/web; Postgres (Aiven) and Redis are managed services. |
| `docs/` | — | `methodology.md` (models), `plan.md` (status + next steps), `data-sources.md`. |

Dependency direction: `core ← db ← cache ← ingest ← intel ← server ← web`. Never import upward.

## Commands

```
pnpm install
pnpm db:migrate                 # applies packages/db/drizzle to DATABASE_URL
pnpm dev:server | dev:worker | dev:web
pnpm typecheck && pnpm lint && pnpm test
pnpm exec tsx --conditions=@ma/source packages/ingest/src/cli.ts universe NIFTY50
pnpm exec tsx --conditions=@ma/source packages/intel/src/cli.ts momentum
pnpm exec tsx --conditions=@ma/source apps/server/src/worker/main.ts <job>   # run one job once
```

Load env with `set -a && . ./.env && set +a`. Every package exports `"@ma/source": "./src/index.ts"` so `tsx --conditions=@ma/source` and vitest run from source; `pnpm build` emits `dist/` for Docker.

## Data model (Postgres, Drizzle)

`companies` (NSE symbol is the natural key) → `company_aliases`, `index_constituents`, `prices_daily`, `fundamentals` (annual/quarterly, ₹ Cr), `announcements`, `analyst_calls`, `documents` (raw fetched text, `parser_version`, `status`), `relationships` (supplier→customer, `disclosure_kind`, `confidence`, `valid_from/to`) → `relationship_estimates` (`method` disclosed|derived|estimated, value + range, `model_version`), `signals` (`kind`, `as_of`, `value`, `inputs` jsonb), `ingest_runs`.

Signal kinds: `customer_concentration_pct`, `top{N}_customers_pct`, `customer_momentum_{1m,2m,3m}`, `supplier_momentum_{1m,2m,3m}`, `customer_hhi`, `distress_score`.

## Conventions

- No comments unless the *why* is non-obvious; no dead code; no TODO markers — put open work in `docs/plan.md`.
- Biome for lint/format (`pnpm lint:fix`). `exactOptionalPropertyTypes` is on: use `?? null`, not `undefined`, for nullable columns.
- Every external fetch goes through `IngestContext.http` (per-host token buckets in `HOST_LIMITS`) or `DocumentStore`; never `fetch` directly in pipelines.
- Parsers carry a `*_PARSER_VERSION`/`*_EXTRACTOR_VERSION`; bump it when output changes so stale documents re-parse.
- Models carry a `*_MODEL_VERSION`; estimates and signals are keyed by it so old rows stay comparable.
- API read models live in `apps/server/src/queries.ts` and are cached through `ctx.api` with explicit `ttlMs/staleMs`; worker jobs invalidate prefixes after writes.
- Web: server components fetch through `apps/web/src/lib/api.ts`; UI copy uses Bloomberg-style function codes (DES, GP, FA, ANR, SPLC, NEWS).
- Commits: conventional (`feat(scope): …`), small, one concern each. `.env` is gitignored (GitHub push protection rejects the Aiven password); `.env.example` is the contract.

## Secrets and services

`DATABASE_URL` (Aiven Postgres), `REDIS_URL` (managed Redis), `FIRECRAWL_API_KEY`, `API_KEY` (shared secret between web and API), `API_URL` (web → API). See `.env.example`.
