# market-analysis

Bloomberg-like intelligence terminal for Indian equities: supply-chain relationships extracted from filings, relationship value estimates, customer momentum, distress scores, event impact analysis, Moneycontrol broker research, Cerebras-generated company and market briefs with cited evidence, and corporate-aircraft and vessel alt-data — one Next.js app on Vercel serving the terminal UI, the cached `/api/v1` read API and the cron jobs.

- Start here: [`AGENTS.md`](AGENTS.md) (codebase map and conventions)
- Models: [`docs/methodology.md`](docs/methodology.md)
- Status and next steps: [`docs/plan.md`](docs/plan.md)
- Sources and caching: [`docs/data-sources.md`](docs/data-sources.md)

## Quick start

```
cp .env.example .env      # fill DATABASE_URL, REDIS_URL, API_KEY, FIRECRAWL_API_KEY, CEREBRAS_API_KEY
pnpm install
pnpm db:migrate
pnpm dev:web              # terminal UI and /api/v1 on :3000
pnpm dev:worker           # queue consumer; `pnpm worker:cli run universe --wait` enqueues one job
```

Deploy `apps/web` to Vercel and `apps/worker` to ECS (`docs/ops.md`); the worker owns every schedule.

## Terminal commands

`CTRL+K` then `DES RELIANCE`, `GP INFY`, `FA TCS`, `ANR INDGN`, `SPLC SONACOMS`, `NEWS RELIANCE`, `HOME`, `MOV`, `SIG distress_score`. Keys `1`–`9` switch company tabs (DES, GP, FA, ANR, SPLC, NEWS, JET, SHIP, INTL).
