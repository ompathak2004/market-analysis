# market-analysis

Bloomberg-like intelligence terminal for Indian equities: supply-chain relationships extracted from filings, relationship value estimates, customer momentum, distress scores, event impact analysis and aggregated broker calls, behind a cached API and a keyboard-driven terminal UI.

- Start here: [`AGENTS.md`](AGENTS.md) (codebase map and conventions)
- Models: [`docs/methodology.md`](docs/methodology.md)
- Status and next steps: [`docs/plan.md`](docs/plan.md)
- Sources and caching: [`docs/data-sources.md`](docs/data-sources.md)

## Quick start

```
cp .env.example .env      # fill DATABASE_URL (Aiven), REDIS_URL, FIRECRAWL_API_KEY, API_KEY
pnpm install
pnpm db:migrate
pnpm dev:server           # API on :4000
pnpm dev:worker           # scheduler
pnpm dev:web              # terminal UI on :3000
```

Or with Docker: `docker compose up --build` (runs migrations, api, worker, web).

## Terminal commands

`CTRL+K` then `DES RELIANCE`, `GP INFY`, `FA TCS`, `ANR INDGN`, `SPLC SONACOMS`, `NEWS RELIANCE`, `HOME`, `MOV`, `SIG distress_score`. Keys `1`–`6` switch company tabs.
