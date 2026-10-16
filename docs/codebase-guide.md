# Understanding market-analysis

Repository walkthrough prepared on 16 October 2026 against commit `d4c458f`.

This guide maps the repository and traces its main execution paths. It distinguishes code that exists from deployment state reported in the runbooks. It is a source review, not a certification of the running AWS/Vercel environment or a line-by-line security audit.

## 1. What this application does

This is a research terminal for Indian listed companies. It combines ordinary financial data with information extracted from filings, broker reports, corporate aircraft movements, shipping activity, and governance/political disclosures.

For a company, it tries to answer:

- What does it do, and how are its prices and financials changing?
- What are brokers recommending, and why?
- Who are its customers and suppliers, and how material are those relationships?
- How might changes at a customer affect the supplier?
- What do recent filings, management travel, logistics, and governance disclosures suggest?
- Which claims have documentary evidence, and which still require review?

The product is primarily a periodically refreshed intelligence system. Its terminal appearance does not imply an exchange-grade streaming market-data feed or a trading execution system.

The checkout contains 297 non-test TypeScript/TSX files, approximately 55,600 lines in those files, 87 test files, 92 application table definitions, 13 SQL migrations, 27 `/api/v1` route handlers, and 47 worker schedule entries. The line count includes reference data: `packages/ingest/src/data/airports.ts` alone is about 5,100 lines. These counts describe repository size, not test coverage or production data coverage.

## 2. The system as a whole

```mermaid
flowchart LR
  B[Browser: terminal UI] --> W[Next.js on Vercel]
  W --> C[L1 memory cache + shared Redis]
  W --> P[(Aiven PostgreSQL)]
  W -. cached quotes and reference prices .-> Y[Yahoo]
  S[Schedules and operator CLI] --> Q[pg-boss queues in PostgreSQL]
  Q --> J[ECS Fargate worker]
  X[NSE, Screener, Moneycontrol, filings, ADS-B, AIS, policy sources] --> J
  L[Cerebras] <--> J
  J --> P
  J --> O[S3: document text and backups]
  J --> C
  J --> M[CloudWatch logs, metrics, alarms]
```

There are two deployable applications:

1. **The web app** serves pages and API responses. It reads stored data, assembles read models, and caches results. Admin review functions are a controlled write exception. Some read models also obtain cached Yahoo quotes on demand.
2. **The worker** owns schedules, ingestion, document processing, model generation, maintenance, and most database writes.

They share PostgreSQL and Redis. The queue itself also lives in PostgreSQL; Redis is not the job queue.

This is best described as a **modular monorepo with separate web and worker processes**. Most domain features are library modules that share a database. They are not independently deployed microservices.

The practical benefits are simpler deployment, shared types, and transactional coordination between queued work and application records. The tradeoffs are a shared database bottleneck and a worker designed around one active consumer.

## 3. Repository structure

| Location | Responsibility | Start reading here |
| --- | --- | --- |
| `apps/web` | Next.js UI, read API, admin review | `src/app/layout.tsx`, `src/server/context.ts` |
| `apps/worker` | Long-running queue consumer and all scheduled processing | `src/main.ts`, `src/consumer.ts`, `src/execute.ts` |
| `packages/core` | Configuration, errors, logging, deadlines, small utilities, object-store interface | `src/config.ts`, `src/deadline.ts` |
| `packages/db` | Drizzle schema, DB connection helpers, migrations, role setup | `src/client.ts`, `src/tables.ts`, `src/schema.ts` |
| `packages/cache` | In-memory LRU, Redis cache, shared token-bucket rate limiter | `src/cache.ts`, `src/rate-limiter.ts` |
| `packages/llm` | Cerebras client, JSON-schema output, retries, token budgets | `src/client.ts`, `src/budget.ts` |
| `packages/ingest` | External sources, parsing, document storage, collection pipelines | `src/context.ts`, `src/documents.ts`, `src/pipelines` |
| `packages/intel` | Derived financial/network signals, grounded extraction, generated insights, influence graph | `src/estimates.ts`, `src/insights`, `src/influence` |
| `packages/jobs` | Job definitions, ledger, leases, retry policies, enqueueing, cache invalidation | `src/contracts.ts`, `src/ledger.ts`, `src/lease.ts` |
| `infra/aws` | CloudFormation, IAM/OIDC, deployment scripts and workflow template | `README.md`, `worker.yaml`, `ci.yaml` |
| `docs` | Models, sources, operations, status and onboarding | `methodology.md`, `data-sources.md`, `ops.md`, `plan.md` |

The workspace uses pnpm, TypeScript ESM, React 19, Next.js 15, Drizzle ORM, the `postgres` driver, ioredis, pg-boss, Zod, Pino, Biome, and Vitest. The intended runtime is Node 22; the root engine declaration allows Node 22 or newer.

Workspace package names such as `@ma/db` refer to local packages. Their exports have a custom `@ma/source` condition for source execution in tests and `tsx`; production builds use emitted `dist` JavaScript.

The intended layering keeps shared infrastructure below domain logic and applications at the top. The manifest graph has some extra cross-dependencies; it is not a perfectly linear chain. For example, intel depends on ingestion and LLM support, while web depends on intel, ingestion, and jobs. Context objects provide a lightweight form of dependency injection: functions receive DB, Redis, HTTP clients, configuration, and logging instead of constructing them repeatedly.

## 4. What happens when somebody opens a company

Example: `/c/RELIANCE/splc`.

1. Next.js matches `apps/web/src/app/c/[symbol]/[tab]/page.tsx`.
2. The page checks that the tab exists, normalizes the symbol, and looks up the company.
3. `TabView` in `components/panes/company/index.tsx` selects the SPLC view.
4. Pane components call functions exported from `server/queries`, using the server context.
5. The query first checks `ctx.api`, the API/read-model cache.
6. On a cache miss, SQL loads relationships, estimates, evidence, coverage, and signals.
7. The result is cached and rendered into the page.
8. Client components add keyboard navigation and other interactions.

```mermaid
sequenceDiagram
  participant Browser
  participant Page as Next.js page / pane
  participant Query as Shared read model
  participant Cache as Memory / Redis
  participant DB as PostgreSQL
  Browser->>Page: Open /c/RELIANCE/splc
  Page->>Query: supplyChain(context, symbol)
  Query->>Cache: getOrLoad(key)
  alt Fresh cached value
    Cache-->>Query: Cached result
  else Cache miss
    Cache->>DB: Load relationships and evidence
    DB-->>Cache: Query result
    Cache-->>Query: Store and return result
  end
  Query-->>Page: Read model
  Page-->>Browser: Rendered panes
```

Server components call read-model functions directly. They do not make HTTP requests to their own REST endpoints. This avoids an extra network hop and keeps API keys out of browser code.

An external API request to `/api/v1/companies/RELIANCE/supply-chain` takes another entry point into the same query function. Its route validates parameters, checks credentials, and formats the response. Sharing the query layer prevents the UI and API from implementing different business rules.

## 5. Frontend design

| Function | Meaning |
| --- | --- |
| DES | Company description and key statistics |
| GP | Price chart |
| FA | Financial analysis |
| ANR | Analyst research |
| SPLC | Customer/supplier relationships |
| NEWS | Filings and news |
| JET | Corporate aircraft and management travel |
| SHIP | Logistics and ports |
| INTL | Intelligence brief |
| INFL | Governance, ownership, political and policy influence |

Global pages are `/`, `/movers`, `/signals`, and `/help`. Admin pages are `/admin/login` and `/admin/review`.

The main frontend directories separate responsibilities:

- `components/shell`: command bar, market strip, clock, help, refresh behavior.
- `components/panes`: domain-specific panels and layouts.
- `components/ui`: reusable tables, charts, chips, gauges, panes, and evidence displays.
- `lib/keymap`: keyboard bindings, row navigation, sorting, pane focus, and scroll activity.
- `styles`: plain CSS; design tokens are centralized in `tokens.css`, layouts in `grid.css`.

React Suspense allows panes to load independently. `attempt()` converts a failed read into a pane-level unavailable state so one failing source does not necessarily break the whole page.

The shell refreshes the route every 120 seconds while the document is visible and the user is not typing. The command bar calls the public search endpoint. Browser local storage preserves the density preference.

The design explicitly targets a dense 1440×900 desktop terminal with internal pane scrolling. Mobile responsiveness is not the main design objective. Much of the charting/UI is implemented directly in components rather than delegated to a large charting or component framework.

## 6. Backend and API boundaries

`apps/web/src/server/context.ts` creates one process-local context through a `globalThis` singleton. This reuses DB and Redis clients within an instance; separate Vercel instances still have separate contexts and memory caches.

Read-model files group queries by subject:

| File | Main responsibility |
| --- | --- |
| `queries/core.ts` | Company lookup, prices, financials, supply chain, announcements, markets |
| `queries/research.ts` | Moneycontrol research data |
| `queries/insights.ts` | Stored briefs, digests, intelligence feed |
| `queries/altdata.ts` | Aircraft, shipping, travel/logistics views |
| `queries/influence.ts` | Confirmed influence graph and paths |
| `queries/screens.ts` | UI-oriented aggregations and presentation models |
| `queries/reviews.ts`, `influence-reviews.ts`, `precision.ts` | Review decisions and precision sampling |
| `queries/ops.ts` | Worker/ledger operational summary |

Route handlers are thin adapters. `server/http/respond.ts` centralizes JSON responses and errors; Zod validates request inputs. Responses normally use `Cache-Control: no-store`: the caching discussed here happens in the application, not automatically in the browser/CDN.

Most data endpoints require `x-api-key`. `/api/v1/search` is public and rate limited. `/api/v1/health` is also unauthenticated in the actual route and reports DB/Redis availability plus job summaries; the repository guide's statement that search is the only public endpoint is therefore incomplete.

Admin routes accept `x-admin-key` or a signed `ma_admin` cookie. The cookie lasts 12 hours, uses HMAC-SHA256, and has HttpOnly/SameSite restrictions. Cookie-authenticated unsafe requests check the request origin. Review is disabled when `ADMIN_API_KEY` is unset.

The ordinary terminal pages are open. An API key on `/api/v1` does not protect server-rendered pages, because those pages invoke queries directly. The current model suits an internal terminal better than a multi-user subscription product; there is no general user-account/tenant/watchlist ownership model.

`/api/cron/[job]` returns HTTP 410. Despite older text in README/AGENTS introductions, Vercel no longer runs the scheduled ingestion jobs.

## 7. Worker and job execution

Start with `apps/worker/src/main.ts`. It constructs the worker context, starts `Consumer`, and installs shutdown handlers.

The consumer:

1. Acquires a PostgreSQL consumer lease.
2. Starts pg-boss and ensures queues exist.
3. Abandons prior attempts and reconciles operational state.
4. Reads `job_control.mode`.
5. When mode is `worker`, registers schedules and consumes jobs.
6. When mode is `paused`, stops claiming work and clears schedules.
7. Renews its lease and publishes metrics periodically.

Job contracts define a type's payload schema, lane, logical unit key, deadline, retry limit, family, and whether it is a fanout or unit. The handler registry connects each type to its implementation.

A **fanout** selects work and creates children; a **unit** processes one company, document, date window, or bounded batch. For example, `fundamentals.fanout` selects up to 30 stale companies in the current code and produces `fundamentals.sync` jobs. Some documentation still says 40.

```mermaid
flowchart TD
  A[Schedule or CLI] --> B[Fanout job]
  B --> C[Campaign + child run records + queued units]
  C --> D[Execute a unit]
  D --> E[Validate payload and start attempt]
  E --> F[Fetch / parse / compute / persist]
  F --> G{Outcome}
  G --> H[Success: finish attempt and invalidate cache]
  G --> I[Transient error: delayed retry]
  G --> J[Budget unavailable: defer]
  G --> K[Permanent/exhausted error: dead]
```

The worker has six queues/lanes:

| Lane | Local concurrency | Purpose |
| --- | ---: | --- |
| control | 1 | Planning, fanout, coordination |
| io | 4 | External requests and collection |
| parse | 1 | Document parsing |
| compute | 2 | Signal/model computation |
| llm | 2 | Model calls |
| cache | 1 | Cache-related work |

These are asynchronous job concurrency limits within one active consumer, not six independently scaled services. External rate limits and the database connection pool impose additional limits.

Three records answer different questions:

- `job_runs`: what logical work is this, and what is its current status?
- `job_attempts`: what happened on each delivery/attempt?
- `ingest_runs` campaigns: how many children did this fanout create, finish, or fail?

Statuses include queued, running, succeeded, failed, deferred, dead, and abandoned. Application-managed retry uses exponential backoff with jitter and Retry-After hints. Exhausted LLM/Firecrawl budgets defer work to a later budget window without spending an ordinary attempt. pg-boss also provides queue-level retry/dead-letter behavior for crashes and expiry.

Child run creation and pg-boss insertion can share the same PostgreSQL transaction. That avoids committing a campaign with child records but no queued work. Batched inserts reduce transaction overhead.

The lease lasts 45 seconds and normally renews every 10 seconds. Each acquisition gets a generation. `assertFence()` checks ownership/generation/expiry and, when supplied, the unfinished attempt before guarded commits. Core deadline state uses AsyncLocalStorage so nested work can observe cancellation and a commit guard without passing every detail through every function signature.

Shutdown stops new claims, drains/aborts work, records attempts where possible, and releases the lease before closing clients. ECS allows 120 seconds; the worker has its own shorter drain/hard-exit limits.

This design provides replay and recovery mechanisms. It should not be read as a universal exactly-once guarantee for every possible external side effect. The correctness comes from stable keys, idempotent writes, transactions, and fencing around the operations that use them.

Selected schedules, all in Asia/Kolkata:

| Work | Schedule |
| --- | --- |
| Universe | Daily 06:30 |
| Prices | Daily 18:30 and catchup 08:15 |
| Price repair | Daily 03:00 |
| Fundamentals | Hourly at minute 10 |
| Announcement fanout | Every 10 minutes |
| Relationship fanout | At minutes 20 and 50 |
| Relationship LLM planning | Daily 05:00 |
| Financial facts / relationship priors | Sunday 01:00 / 02:00 |
| Intelligence network | Daily 02:30 and 14:30 |
| Company insight fanout | Every 10 minutes |
| Market briefs | Weekdays 09:00 and 15:50 |
| Aircraft samples / AIS bursts | Every 5 / 10 minutes |
| Ops reconciliation / digest | Every 15 minutes / daily 08:00 |

A schedule's frequency is not a promise that every company refreshes that often. Fanouts select bounded batches using freshness, failure cooldowns, universe membership, deadlines, and available budgets.

## 8. Ingestion: how outside data gets inside

`packages/ingest` has three important layers:

1. **Sources** know an upstream's URLs, response formats, and parsing rules.
2. **Pipelines** coordinate source reads and persistence for a business task.
3. **Extractors** turn text into financial facts, relationship observations, or other structured output.

| Source family | Main data |
| --- | --- |
| NSE | Universe/index membership, announcements, structured governance/RPT filings, listing identity |
| Yahoo | Quotes, historical bars, splits/dividends, indices, reference prices |
| Screener | Consolidated fundamentals, annual-report and concall links |
| Moneycontrol | Broker calls, targets, consensus, estimates, ownership and report PDFs |
| Rating rationales / presentations | Additional customer and supplier disclosures |
| adsb.lol / OpenSky / registries | Aircraft identity, positions, traces |
| AISStream | Vessel observations in watched zones |
| Sansad / MyNeta / SBI disclosure PDFs | Political offices, declared interests, electoral bonds |
| PIB / PRS / eGazette | Government policy and legislative events |

`HttpClient` supplies timeouts, retries, conditional request headers, logging, and shared per-host rate limits. The rate limiter uses a Redis Lua token bucket, so separate processes share the same source allowance. For example, Yahoo history has its own 5-per-10-seconds bucket in addition to host limits.

`DocumentStore` handles freshness, extraction, hashing, and revisions. It can fetch directly, use Firecrawl, or fall back to Firecrawl for suitable blocked/failed reads. HTML uses source-specific extraction/Cheerio; PDFs use unpdf. Firecrawl has a separate monthly credit budget.

Example fundamentals pipeline:

`fundamentals.sync` → load company → fetch/reuse Screener document → parse annual/quarterly tables → compare parser version/content state → upsert fundamentals and company metadata → mark parsed → mark company synced → invalidate relevant read models.

Most repeated work is avoided through freshness windows, document hashes, parser versions, extraction hashes, and database uniqueness constraints. A successful job does not necessarily mean it inserted new rows; unchanged input can be a successful no-op.

## 9. Documents, evidence, and S3

```mermaid
flowchart LR
  D[documents: URL and current pointer] --> R[document_revisions: immutable extracted text revision]
  R --> S[S3 compressed text, or inline text while retained]
  R --> E[evidence_spans: exact quote and offsets]
  E --> O[Relationship / influence observations]
  O --> G[Reviewed or materialized graph edges]
```

`documents` identifies a source URL and points to its current revision. `document_revisions` identifies a distinct extracted body and text parser version. `evidence_spans` points to UTF-16 offsets in that immutable text, with a quote, page, and optional locator.

This prevents a later change at the same URL from silently changing what an older claim cited. A citation is more precise than a link to an entire PDF. Durable hydration of an old revision depends on its archived text: without an object store, the inline body belongs only to the current document revision, so a replaced revision's full text may become unavailable after its small in-memory cache entry is gone. Stored evidence quotes remain separate records.

The `ObjectStore` interface lives in core. The concrete AWS S3 implementation lives in the worker, keeping AWS-specific storage code out of parsers/models. Text is gzipped and stored under content-addressed keys. Object checksums and text hashes are checked when writing or hydrating data.

Blob writes happen before the database transaction. A failed transaction may leave an unreferenced object, which garbage collection can remove; it should not leave a committed revision pointing to an object that was never uploaded.

Document maintenance snapshots legacy inline content, verifies blobs before releasing inline bodies, and removes sufficiently old unreferenced objects. The code supports a `raw/` namespace, but the current document persistence path marks raw content unavailable; extracted text preservation is not the same as preserving every original PDF/HTML/provider payload.

The web context does not construct the worker's S3ObjectStore. Its normal views use stored facts and evidence quotes rather than downloading whole archived documents.

## 10. PostgreSQL: the main data model

PostgreSQL is the durable source of truth for business data, provenance, models, queue state, reviews, and operations. Redis holds derived or temporary state. S3 holds blobs and backup exports.

Drizzle gives typed table definitions and queries. More involved read models also use parameterized SQL, CTEs, lateral joins, aggregation, and distinct-on queries. The graphs are represented relationally; there is no separate graph database.

| Domain | Principal tables |
| --- | --- |
| Company identity/universe | `companies`, `company_aliases`, `indices`, `index_constituents`, `company_sync` |
| Market history | `prices_daily`, `index_prices_daily`, `price_series_state`, `market_symbols`, `trading_sessions`, `corporate_actions`, `price_gaps`, `price_manifests`, `price_manifest_companies` |
| Financials/filings | `fundamentals`, `announcements`, `analyst_calls`, `announcement_holds` |
| Documents/provenance | `documents`, `document_revisions`, `evidence_spans`, `storage_objects` |
| Supply-chain identities | `counterparties`, identifiers, aliases, `company_group_memberships` |
| Supply-chain extraction | `relationship_sources`, `relationship_extractions`, `relationship_observations`, `relationship_observation_evidence` |
| Supply-chain graph/model/review | `relationships`, `relationship_estimates`, `relationship_priors`, `relationship_financial_facts`, `relationship_blocks`, `relationship_reviews`, `company_graph_state`, precision samples/items |
| Research | `shareholding`, `analyst_ratings`, `consensus_history`, `earnings_estimates`, `price_targets`, `earnings_surprises`, `company_facts` |
| Intelligence | `signals`, `insights`, `llm_usage`, `llm_usage_daily` |
| Aircraft | `corporate_aircraft`, `corporate_aircraft_companies`, `aircraft_positions`, `aircraft_flights` |
| Maritime/facilities | `facilities`, `facility_companies`, `vessels`, `vessel_positions`, `vessel_calls`, `chokepoint_transits`, `vessel_fleet` |
| Alt-data quality/events | `altdata_events`, `altdata_coverage` |
| Influence identities/facts | `persons`, aliases/identifiers, `graph_nodes`, `person_roles`, `ownership`, `related_party_transactions`, `political_roles`, `affidavit_interests`, `electoral_bond_rows`, `political_donations` |
| Policy/influence graph | `policy_sectors`, `company_policy_sectors`, `policy_events`, `policy_event_tags`, `influence_edges`, evidence/reviews/extractions/events/event-edges/coverage |
| Job operations | `ingest_runs`, `job_runs`, `job_attempts`, `job_daily_stats`, `worker_leases`, `job_control`, `ops_alerts` |

NSE symbols are natural business identifiers, but numeric IDs are used for joins. SQL column names use snake_case; TypeScript fields use camelCase. Financial statement amounts are generally in rupee crore; price fields are in rupees. Treat units as part of the data contract.

Schema definitions are split between `src/schema.ts` and `src/schema/{evidence,splc,announcements,influence}.ts`, all exported through `tables.ts`. The 13 SQL migrations run from `0000` through `0012`. Handwritten SQL supplies functions, views, and constraints beyond the generated statements.

The migrator takes a session advisory lock so two runners cannot apply a batch simultaneously. A migration is a schema/data-changing operation; it is not required merely to browse an existing production database.

### Roles and resource limits

The bootstrap script defines a useful separation:

| Role | Connection limit | Intended rights |
| --- | ---: | --- |
| `ma_web` | 5 | SELECT, plus explicit execution of review functions |
| `ma_worker` | 3 | Application DML and ownership of pg-boss schema |
| `ma_migrator` | 1 | Application schema ownership and migration privileges |

Web pools have at most two connections per instance and a 5-second statement timeout. The worker app pool is two plus a separate one-connection queue pool. Role limits apply across instances, so raising Vercel concurrency does not create unlimited DB capacity.

The review functions use SECURITY DEFINER with restricted execution grants. The web starts an explicit read-write transaction to call them because its normal role defaults to read-only. These are intentional controlled writes, so “web is read-only” needs that qualification.

The runbook describes a very small Aiven connection budget. These limits and privileges are defined in source; whether the live database currently matches them was not checked.

## 11. Prices and financial models

Price ingestion is more rigorous than a simple daily-bar upsert:

- Each company/index has series state and an intended five-year window.
- Source symbols must belong to the requested series; ISIN/listing mismatches can become durable exceptions.
- Trading sessions define expected coverage; missing periods are recorded as gaps with reasons.
- Bars carry source, parser version, generation, and finality metadata.
- A new/corrected split or dividend triggers a rebuild instead of repeatedly rescaling existing values.
- A rebuild switches generation transactionally after completeness checks.
- Backfill manifests freeze which companies and units belonged to a campaign.

OHLC is split-adjusted; adjusted close is split-and-dividend-adjusted. Indices represent price-return levels. Analytics use final adjusted-close bars on the current generation. The UI can show provisional bars with an explicit finality flag.

These distinctions prevent false returns from mixing incompatible price histories. Limitations remain: the calendar is derived from Yahoo's NIFTY dates, and rights issues/demergers are not comprehensively modeled. Raw historical provider payloads are not currently archived.

`packages/intel` turns stored data into models:

| Model | What it does | Important qualification |
| --- | --- | --- |
| Relationship values | Uses disclosed amounts/shares, derived values, then statistical priors | Values may legitimately remain unknown |
| Customer/supplier momentum | Weighted returns of connected counterparties over several horizons | Missing prices reduce coverage rather than become zero returns |
| Concentration/HHI | Measures concentration among valued counterparties | Unvalued relationships are recorded separately |
| Distress | Combines standardized leverage, coverage, profitability and efficiency ratios | Relative ordering score, not a calibrated default probability |
| Event impact | OLS compares supplier returns with/without exposure to a shock company | Association and sample fit do not establish causation |
| Travel/logistics | Derives activity patterns and exposure-related signals | Quality depends on source coverage and identity links |

For momentum, if two customers have normalized weights 0.6 and 0.4 and returns 10% and -5%, customer momentum is `0.6 × 10% + 0.4 × -5% = 4%`. This is an illustration of the weighted calculation, not a prediction that the supplier will return 4%.

Parser/extractor versions describe how input becomes facts; model versions describe how facts become outputs. Readers pin graph-derived signal kinds to active versions rather than assuming the highest stored version is the intended one.

**Current defect:** the scheduled worker invokes distress calculation with one company, while the model standardizes across its input companies. Section 17 explains why that prevents new worker-generated distress scores.

## 12. Supply-chain intelligence

SPLC is a substantial subsystem, not just a table of supplier names.

1. Counterparty resolution identifies listed companies, private companies, governments, foreign entities, and groups.
2. A regex/cue pass finds candidate relationships in filings and other stored text.
3. A bounded LLM pass reads selected sections to improve extraction.
4. Claims become observations linked to immutable evidence spans.
5. High-confidence/accepted observations materialize into supplier → customer edges; ambiguous observations can enter review.
6. Models assign values and compute concentration/momentum.
7. Read models display the graph with evidence and coverage.

The extractor rejects or downgrades misleading mentions such as peers, self-mentions, and same-group cues. Reviewed decisions are preserved across extraction reruns. Relationships expire when disclosure evidence gets old; the configured lifetime is four years.

The model keeps `revenue_share`, `purchase_share`, `annual_flow`, and `contract_total` distinct. A multi-year contract total must not be added to an annual revenue flow. This is a strong and necessary domain distinction.

Statistical priors require a minimum sample, such as 20 disclosed shares from five suppliers per group. The estimates record inputs/reasons and can cap aggregate estimated exposure to the customer's cost base.

Precision sampling creates a reproducible frozen set for human labeling. The gate requires all sampled items to be decided and a Wilson 95% lower confidence bound of at least 0.9. With 100 items, 96 confirmations are required. Having the gate implemented does not establish that a production sample has passed it.

## 13. LLM intelligence

The LLM provider is Cerebras. Current configured defaults are `gpt-oss-120b` with `qwen-3.8-27b` as fallback; these are repository settings, not an independently checked provider availability claim.

The model produces company briefs, broker digests, market briefs, announcement triage, broker report theses, relationship extraction, and selected policy tags.

The client:

- Converts Zod output schemas into strict JSON schemas.
- Limits prompt size and completion size.
- Retries transient HTTP failures.
- Can retry invalid output with validation feedback and then a fallback model.
- Reserves a token allowance before a request and settles it against reported usage.
- Records usage, latency, model, and output validity.

An 800,000-token daily total is divided by default into relationships 200,000, insights 500,000, and influence 100,000. Redis enforces both class and total limits. Calls also share a configured request rate. Budget reset boundaries are UTC; worker schedules use India time.

This is grounded generation over assembled structured inputs and selected source sections. There is no vector database or embedding-based retrieval layer in this design. Claims are checked against allowed evidence IDs and numbers; relationship quotes must be locatable back in the cited text. Unsupported claims can be retried, removed, or rejected.

Insights record input hashes and versions. Regeneration logic considers changed inputs, freshness/materiality rules, and force options; it is not simply “call the model whenever a user opens the page.” Stored results are served through the normal read models.

These checks reduce hallucination risk but do not prove every interpretation is correct. Human review and measured extraction precision remain meaningful.

## 14. Aircraft, vessels, and influence

Aircraft pipelines seed a corporate-aircraft registry, collect positions and daily traces, merge available source data, derive flight legs, and compute travel signals. Per-aircraft advisory locks coordinate trace persistence and leg re-derivation. Replay logic rewinds when a daily trace starts in the middle of a flight.

The leg rules deliberately account for coverage gaps at altitude so a short loss of reception is not automatically interpreted as a landing. The consequence is that a real turnaround at an airport without coverage can also be hard to resolve. Corporate ownership links and incomplete endpoints must be interpreted with their evidence/quality flags.

Maritime collection samples AISStream in watched zones. Positions become port calls and chokepoint transits; fleet/facility mappings connect them to companies. Travel/logistics models turn those into stored signals and event feeds. The runbook reports weak coverage at Indian ports; absence of observations does not establish absence of activity.

INFL is a second relational graph covering people, directorships, ownership, related-party transactions, political offices/interests, donations, sectors, and policy events. It uses explicit identity resolution and confidence bands. Strong structured identifiers can support automatic confirmation; name-only or LLM-derived links generally require review.

Confirmed paths require confirmed, evidenced hops. Review functions use optimistic version checks to avoid silently overwriting a concurrent decision. Events and extraction hashes make repeated reads idempotent. Policy tagging uses ministry/sector rules first and an LLM fallback when rules cannot classify it.

The operational limitations are real: some bond/gazette jobs require manually supplied PDF URLs; ministerial portfolios/term dates and affidavit coverage are incomplete. Code support for a source is not proof that its latest data has been ingested.

## 15. How caching works

There are two broad namespaces: `ingest:v1:` for upstream/ingestion-related caching and `api:v3:` for read models.

Each Cache instance has:

1. **L1:** a bounded in-process LRU, normally at most 5,000 entries with a 5-second freshness cap.
2. **L2:** shared Redis entries containing value, fresh-until, and stale-until timestamps.
3. **Single-flight:** concurrent cold loads within that instance share a promise.
4. **Stale-while-revalidate:** an acceptable stale value returns immediately while refresh is attempted.
5. **A Redis refresh lock:** reduces duplicate stale refresh work across instances.
6. **Negative caching:** missing entities can be cached briefly.
7. **Metrics:** hits, misses, stale responses, coalescing, negatives, and errors.

Examples from the read models:

| Data | Fresh duration | Additional stale allowance |
| --- | ---: | ---: |
| Company identity | 1 hour | 6 hours |
| Search | 10 minutes | 1 hour |
| Yahoo quote | 1 minute | 5 minutes |
| Latest signals | 15 minutes | 1 hour |
| Supply chain | 30 minutes | 6 hours |
| Company research | 10 minutes | 1 hour |
| Travel/logistics | 5 minutes | 30 minutes |
| Influence | 30 minutes | 6 hours |

`FAMILY_INVALIDATIONS` maps completed job families to affected cache prefixes. The worker removes shared Redis entries after writes, and tests compare the mapping to read-model prefixes.

This is **eventual consistency**. Invalidation on the worker does not directly erase a web instance's L1 memory; the short local freshness cap bounds the ordinary residual window. In-flight loads and background refreshes also need consideration when stronger freshness is required.

Cold-miss single-flight is local to one Cache instance; the distributed lock applies to stale refresh. Multiple cold Vercel instances can still load the same key at once.

Redis is more than an optional speed boost: it also enforces rate limits and budgets. Although cache reads catch Redis failures, writes during a miss are awaited and can fail the request. Do not assume the entire app seamlessly operates through a Redis outage. Background stale refresh is launched without a platform lifetime hook, so completion on a serverless host should also be validated operationally.

## 16. AWS and deployment

The worker infrastructure is plain CloudFormation in `infra/aws/worker.yaml`, targeting `ap-south-1`.

| Service | Role in this repository |
| --- | --- |
| ECS Fargate | Runs the worker container |
| Fargate Spot | Default lower-cost capacity choice; interruption/capacity availability are tradeoffs |
| ECR | Stores built worker images, tagged with commit SHA and latest; retains recent images |
| SSM Parameter Store | Supplies encrypted configuration/secrets at task startup |
| S3 | Private archive bucket for extracted document text and backup exports |
| CloudWatch Logs | Worker JSON logs, 14-day retention |
| CloudWatch metrics/alarms | Heartbeat, task absence, dead jobs |
| SNS | Alarm notifications |
| AWS Budgets | Configured monthly cost notification thresholds |
| IAM/OIDC | Runtime permissions and GitHub deployment identity |

PostgreSQL is documented as Aiven-hosted; Redis is separately managed. Neither is provisioned as RDS/ElastiCache by this stack. The frontend runs on Vercel rather than ECS, and the worker does not need a public HTTP load balancer.

The task is configured for 0.25 vCPU, 1 GiB RAM, x86 Linux, and one desired task. A PostgreSQL lease still ensures a single active consumer. Public subnets and a public IP provide outbound internet access without a NAT gateway; the security group has no incoming service rule and allows outbound traffic.

Deployment uses stop-then-start settings (`MinimumHealthyPercent: 0`, `MaximumPercent: 100`) and an ECS deployment circuit breaker with rollback. A short ingestion gap during deployment is a deliberate tradeoff of the single-worker/resource-constrained design.

S3 blocks public access, uses AES256 server-side encryption, requires secure transport, and expires `backups/` after 90 days. Application-level AES-256-GCM can additionally encrypt announcement backup exports when `BACKUP_ENCRYPTION_KEY` is set. An archive bucket and a cleanup backup job do not by themselves demonstrate a tested full database disaster-recovery plan.

IAM separates the task execution role (image/logging/SSM startup needs) from runtime permissions (S3 and CloudWatch). `ci.yaml` defines GitHub OIDC access, restricting the trusted repository/branch and deploy permissions. It avoids requiring a static AWS access key in the GitHub workflow.

### Worker image

The multi-stage Dockerfile:

1. Uses Node 22 and the pinned package manager.
2. Fetches dependencies from the lockfile, then installs offline during the build stage.
3. Builds shared packages and worker TypeScript.
4. Deploys production workspace dependencies to an output directory.
5. Removes source/tooling from the runtime payload and runs as a non-root user.
6. Starts compiled `dist/main.js`, not tsx.

### Deployment workflow

The workflow template describes:

`checkout → install → typecheck/lint → migrate disposable test DB → tests → build/push image → migrate production schema → register task definition → deploy and wait for stability`.

It uses local PostgreSQL 16 and Redis 7 service containers for verification. Failed migrations stop deployment. Schema migrations still need compatibility with the old worker that may be running while they execute.

**The checkout has no `.github/workflows` directory.** The workflow is a template at `infra/aws/github-workflow-worker.yml`; the runbook explicitly says to copy it into the active workflow location. Do not infer that push-to-main CI/CD is enabled merely because this YAML exists.

`deploy.sh` is a manual build/push/deploy path; it does not perform the workflow's verification and migration steps. CloudFormation and image deployment also manage parts of the same task definition/service, so the runbook warns to preserve the current image tag on later stack updates.

SSM values are injected into the container only when referenced by its task definition, and changes take effect on a new task. The current template omits several newer settings; see the findings below.

## 17. Findings that affect the assessment

These findings come from the inspected checkout. No application fixes or production changes were made during this walkthrough.

### High priority: worker distress scoring has the wrong scope

- `apps/worker/src/handlers/intel.ts:32` calls `refreshRiskSignals(db, [companyId], asOf)`.
- `packages/intel/src/risk.ts` loads only those IDs and computes z-scores across the resulting rows.
- `packages/intel/src/stats.ts:46` returns null z-scores when fewer than two observations exist.
- With a singleton input, every standardized feature is null, so the risk model skips writing a score.

Result: the worker can successfully complete this unit while producing zero new distress signals. Old rows or runs of the direct intel CLI may still explain visible existing scores. The direct CLI passes the company cohort and therefore follows a different calculation path.

The pure helper was executed locally: `zScores([2])` returned `[null]`, whereas a two-value input standardized normally. The full DB-backed worker path was not executed here.

The appropriate correction is to compute normalization over the intended comparison cohort and then persist per-company outputs, or run the risk pass once over that cohort. A worker-to-model integration test should catch a successful job that produces no expected scores.

### Deployment configuration is behind application configuration

`worker.yaml` does not reference `OPS_DIGEST_TO`, `LLM_BUDGET_RELATIONSHIPS`, `LLM_BUDGET_INSIGHTS`, `LLM_BUDGET_INFLUENCE`, or `SPLC_PRESENTATIONS_PILOT`, even though the application reads them.

Uploading these names into SSM alone does not expose them to the task. With this template, custom class caps do not override the code defaults, the presentation pilot remains off by default, and the digest has no recipient unless the deployed task definition was modified separately. The send function explicitly returns without emailing when the recipient is absent.

### Deployment automation is supplied as a template

There is no active GitHub Actions workflow in this checkout. This makes the promised verification/deploy path an available design rather than an enabled repository guarantee.

### Queue database TLS does not verify the server certificate

`apps/worker/src/context.ts:95` sets `ssl: { rejectUnauthorized: false }` for non-local pg-boss connections. Encryption is enabled, but server certificate authentication is disabled. Trusting the managed provider's CA while keeping verification enabled would be preferable.

### Other limitations to understand

- Public pages are not protected by the API-key middleware; general web authentication is listed as future work.
- Redis failures are not uniformly isolated from requests or budget enforcement.
- One active worker, a small app pool, and a shared small Postgres instance limit throughput and availability.
- Several domain files are large: price ingestion is about 1,575 lines, insight input assembly about 1,405, and the central schema about 1,143. Splitting these by coherent responsibility would reduce maintenance difficulty.
- External scraping and PDF layouts can change despite parser tests.
- The plan explicitly reports unrun backfills, pending production rollout, and weak alt-data coverage.
- Some guide text is stale: retired web crons, fundamentals batch size, and the public health route are examples.

## 18. Codebase rating

**Overall: 7.5/10 for the current checkout as an internal research/intelligence product.** This is a judgment of design and implementation evidence, not a measured production SLA or an arithmetic quality metric.

| Area | Rating | Reason |
| --- | ---: | --- |
| Architecture | 8.5 | Useful package boundaries and separate request/background workloads |
| Data modeling and provenance | 8.5 | Revisions, evidence spans, units/bases, versions, graph review, quality metadata |
| Job infrastructure | 8 | Ledger, transactional fanout, retries, deferrals, lease fencing and shutdown handling |
| Cache design | 7.5 | Practical layers and invalidation; outage/serverless/distributed freshness caveats |
| Testing strategy | 7 | Substantial unit/DB tests, but important composition behavior escaped; no browser E2E setup found |
| Maintainability/onboarding | 7 | Strict typing and conventions, offset by broad barrels, large files, and some documentation drift |
| Security boundaries | 6.5 | Strong DB-role/admin choices, but public pages and disabled queue certificate verification |
| Deployment completeness | 6.5 | Detailed infrastructure/runbooks, with inactive workflow and missing environment wiring |

The strongest work is in provenance and pipeline reliability. The main reason to withhold an 8.5–9 rating is the gap between sophisticated components and verified end-to-end behavior: distress scoring is one concrete example, and deployment/data-coverage status provides others.

Production confidence is lower than architectural confidence. This walkthrough did not inspect live AWS resources, grants, data freshness, alarm history, source success rates, restore drills, latency under load, or labeled extraction quality.

## 19. Tests and what was verified here

Vitest separates a parallel `unit` project and serial `db` project. Many DB tests skip unless `DATABASE_URL_TEST` is present. Parser fixtures cover representative source formats; worker tests exercise execution outcomes and database tests cover important persistence/review behavior.

The `unit` label does not mean every test is infrastructure-free. Cache/rate-limit tests use Redis, and the cache tests call `flushdb()`. Run tests with disposable local/test services and explicitly configured test URLs. Do not point the test process at a production Redis database.

The workflow template provisions separate service containers, which is the intended automated test setting. This checkout has no browser E2E configuration or local Docker Compose setup.

For this review:

- Repository structure, manifests, schemas, migrations, core paths, source/model modules, cache behavior, tests, and infrastructure/runbooks were inspected.
- The actual z-score helper was executed to check singleton behavior.
- The full typecheck/lint/test/build suite was not run: node_modules is absent, and pnpm's attempt to obtain the pinned version failed because registry DNS resolution failed.
- No production endpoints, secrets, databases, or AWS resources were contacted or changed.

## 20. Running and learning it locally

Use a local or dedicated development PostgreSQL database and Redis instance. Fill `.env` from `.env.example`. The custom Node/tsx entry points expect variables in the process environment; do not assume every command automatically loads the root `.env`.

The repository's documented Bash environment-loading approach is:

```bash
cp .env.example .env
# Edit .env with local service URLs and required configuration.
set -a && . ./.env && set +a
pnpm install
pnpm db:migrate
pnpm dev:web
```

On Windows, use Git Bash for that snippet, or set the equivalent `$env:NAME` values in PowerShell. For example, `$env:DATABASE_URL = 'postgres://postgres:postgres@localhost:5432/market_analysis'`. The web config currently also requires nonempty Firecrawl/Cerebras configuration even though ordinary web rendering does not generate LLM output; this reflects shared service configuration.

In another terminal with the same development environment loaded:

```bash
pnpm dev:worker
```

Then use the CLI against that development database:

```bash
pnpm worker:cli types
pnpm worker:cli schedules
pnpm worker:cli status
pnpm worker:cli mode worker
pnpm worker:cli run universe --wait
```

A new database starts with job mode paused. Enqueueing alone does not make a paused worker consume jobs. Starting a worker in worker mode also enables its schedules unless configured otherwise.

Data loading has dependencies: load the universe first; then populate prices, fundamentals, filings and research; then compute models/briefs. An empty UI after a clean migration usually means data ingestion has not run yet, rather than that the UI is broken. A full historical backfill is substantial work and is not needed just to understand the source tree.

Use terminal commands such as `DES RELIANCE`, `GP INFY`, `SPLC SONACOMS`, `HOME`, and `MOV` once the corresponding companies/data exist.

Standard checks are:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build:web
pnpm build:worker
```

Only run the tests after configuring disposable services as described above. Build scripts first compile shared packages; development/test execution can resolve source through `@ma/source`.

### Suggested reading order

1. `AGENTS.md`, this guide, and `docs/plan.md` for the map and implemented-versus-deployed distinction.
2. `apps/web/src/app/c/[symbol]/[tab]/page.tsx`, `components/panes/company/index.tsx`, a simple pane, and its shared query.
3. `apps/web/src/server/context.ts`, `server/http`, and `packages/cache/src/cache.ts` for request infrastructure.
4. `packages/db/src/schema.ts`, the domain schema files, and role bootstrap for persistence boundaries.
5. `apps/worker/src/main.ts`, `consumer.ts`, `execute.ts`, and `packages/jobs/src/contracts.ts` for background execution.
6. Follow `handlers/market.ts` → `pipelines/fundamentals.ts` → `sources/screener.ts` as a complete small ingestion example.
7. Read `documents.ts`, evidence schema, relationship extraction/graph writing, and the SPLC read model together.
8. Read `docs/methodology.md` before changing estimates, momentum, risk, or event models.
9. Read the LLM client/budget, one brief generator, and grounding validation together.
10. Finish with alt-data, influence, Dockerfile, `infra/aws`, and `docs/ops.md`.

### Where to make common changes

| Desired change | Likely starting point | Related work |
| --- | --- | --- |
| Change a pane | `apps/web/src/components/panes` | Shared query and CSS tokens/layout |
| Add an API endpoint | `apps/web/src/app/api/v1` | Validation, auth, shared read model |
| Add a source | `packages/ingest/src/sources` | Host limit, parser fixture/version, document policy |
| Add scheduled processing | `packages/jobs/src/contracts.ts`, worker handler registry | Schedule, lane/deadline, unit key, invalidation, ops visibility |
| Add persisted data | `packages/db/src/schema*` | Migration, indexes/constraints, role/function grants |
| Change an extraction | `packages/ingest/src/extract` or intel extraction adapters | Extractor version, fixtures, evidence/precision checks |
| Change a signal | `packages/intel/src` | Model version, active version map, inputs/coverage, tests |
| Change deployment config | `infra/aws/worker.yaml` | App schema, SSM references, new task rollout |

Learn one complete path from source to screen first. The repeated structure—collect, preserve evidence, parse, version, compute, cache, render—then makes the larger subsystems much easier to navigate.
