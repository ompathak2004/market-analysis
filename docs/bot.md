# /bot — financial intelligence assistant

Conversational assistant over the terminal's own data: demo portfolios, prices, fundamentals, NSE filings with triage, broker research, the SPLC supply-chain graph, graph-derived signals, alt-data and a versioned Indian capital-gains engine. The model explains numbers; deterministic code computes them.

## Decisions (2026-11-12)

| Topic | Decision | Why |
| --- | --- | --- |
| Runtime | Custom loop in `packages/agent` over Cerebras OpenAI-compatible `/chat/completions` with SSE | No framework needed for ~15 read-only tools; full control of validation, budgets and tool-call leaks. AI SDK's Cerebras provider had multi-step reasoning bugs; Mastra needs a storage adapter we do not have. |
| Boundary | `@ma/agent` depends on `@ma/core`, `@ma/llm` (schema conversion, token estimate) and `zod`; it does no I/O. Web wires tools to `@/server/queries` and reserves tokens through `LlmBudget` class `chat`. | Web never loads pg-boss or `LlmClient`; interactive inference is a separate, bounded path that shares the worker RPM bucket and daily total. |
| Model | `gpt-oss-120b` primary (`reasoning_effort: low`), `qwen-3.8-27b` fallback, both from `BOT_MODEL`/`BOT_FALLBACK_MODEL` | Only two shared Cerebras models; both support strict tools, `tool_choice` and parallel calls. gpt-oss is cheaper ($0.35/$0.75 per 1M) with higher TPM. Choice confirmed by `pnpm --filter @ma/web bot:eval`. |
| Conversation state | Server-side in Redis keyed by an unguessable conversation id, 7-day TTL; the client only sends the new message | Client-held transcripts can forge assistant/tool turns. No new tables, no migration, `ma_web` stays read-only. |
| Context | System prompt + selected portfolio + compacted memory + last 6 turns verbatim + current tool loop, within a fixed token budget; tool results are capped and referenced by id | Bounded and testable; Mastra observational memory needs background LLM calls and SQL storage, not worth it for short sessions. |
| Charts | Tools emit validated chart specs (`packages/agent/src/viz.ts`); the client maps specs to trusted SVG components | The model never produces code; every chart carries the tool call id that produced it. No chart library: existing panes already draw SVG. |
| Tax | Versioned rule windows keyed by transfer date (1961 Act before 1 Apr 2026, Income-tax Act 2025 after) | Rates changed on 23 Jul 2024; sections renumbered on 1 Apr 2026. |
| Observability | One JSON trace per request in Redis (14-day TTL) plus pino logs; admin-only `GET /api/v1/bot/traces/:id` | No new vendor; span names follow OTel conventions so export is possible later. |

## Data limits that shape answers

- Equity closes start 2024-09-25 for most of the universe and 2026-09-08 for later additions; index levels cover only recent sessions. Returns, drawdown and benchmark comparisons state the window they actually used.
- `corporate_actions` holds splits and dividends from late 2026 only; bonuses are not ingested. Demo ledgers are recorded on the split-adjusted basis as of their `basisAsOf` date.
- "News" is NSE filings (with LLM triage) and PIB/PRS/gazette policy events; there is no general newswire.

## Tools

| Tool | Data | Output |
| --- | --- | --- |
| `portfolio_overview` | demo ledger, final NSE closes, corporate actions | totals, holdings, sector weights, HHI/top-N; KPI, donut, table |
| `portfolio_performance` | value series, index levels | window TWR and contributions, XIRR, drawdown, benchmark; line, bar |
| `portfolio_scenario` | valuation | deterministic shocks by symbol/sector/largest/all; bar |
| `portfolio_tax` | lots, `tax/` rules | realized, sell-today or wait-for-LTCG with same-year booked gains; table, bar |
| `portfolio_signals` | `signals` (active versions) | distress, customer/supplier momentum, concentration, travel, logistics with nature labels; table |
| `portfolio_news_impact` | filings with triage, PIB/PRS policy tags, SPLC edges | channels per holding (direct, policy sector, customer/supplier event), exposure where quantified; network, timeline |
| `supply_chain` | SPLC edges, estimates, evidence spans | customers/suppliers with evidence; network |
| `company_research` | every company read model plus counterparty revenue | one dossier: valuation, price, CAGR and margins, fiscal-quarter YoY, cleaned supply chain (generic labels, regulators, depositories, director/compliance text, award-direction errors and implausible estimates set aside), graph signals, JET, SHIP, ownership, street view, material filings, AI brief, data gaps; KPI, bar, network, table, timeline |
| `event_impact` | `eventImpact` OLS | exposure coefficient, ΔR², missing suppliers; bar |
| `company_lookup`, `company_snapshot`, `company_financials`, `company_prices`, `broker_research` | read models | stats, AI brief with evidence, statements, closes, broker calls; KPI, bar, line |
| `market_news`, `tax_rules`, `conversation_recall` | filings/policy, rules table, Redis conversation | timeline, rules with `appliesToSalesToday`, earlier turn |

## Evaluation (2026-11-12, prompt `bot-2026-11-12.3`→`.4`)

`pnpm --filter @ma/web bot:eval` runs 12 golden cases (13 turns). Ground truth comes from calling the same deterministic tools; graders check tool selection, exact rupee/percent strings, citation validity, chart kinds, causal-language and injection patterns.

| Model | Cases | Tool recall | Numeric checks | Invalid citations | p50 / p95 latency | Cost per turn |
| --- | --- | --- | --- | --- | --- | --- |
| `gpt-oss-120b` (full set) | 8/12 | 1.00 | 85 % | 0 | 23.7 s / 36.3 s | $0.0021 |
| `gpt-oss-120b` (4 failures rerun after fixes) | 3/4 (4/4 after grader fix) | 1.00 | — | 0 | 6.9 s / 35.1 s | $0.0022 |
| `qwen-3.8-27b` (5-case subset) | 3/5 (4/5 after grader fix) | 1.00 | 80 % | 0 | 23.5 s / 34.5 s | $0.0088 |

Failures the first run exposed and their fixes: unit conversion of rupee amounts (tools now send display strings), citation ranges and `【S2】` brackets (prompt + parser), 1961-Act sections quoted for tax year 2026-27 (`appliesToSalesToday`), a price move attributed to news (prompt rule, non-attribution field), and identical SPLC estimates shown as per-customer facts (suppressed). qwen returned one empty answer and costs four times as much, so `gpt-oss-120b` stays primary and qwen is only the provider-failure fallback. A full regression rerun was not done because the daily `chat` budget was nearly spent; run it before changing prompts or models.

Latency is dominated by the shared 5 RPM limit on the Free Trial key: an unqueued two-call turn completes in 4–7 s (first token 3–6 s), but a burst waits for the RPM bucket. Objective: p50 under 10 s and p95 under 30 s once the key is on the Developer tier; today p95 is not met under load.

## Known limitations

- Research notes are only as good as the SPLC graph: the dossier sets aside rows it can show are wrong (for SHRIPISTON, carmakers recorded as suppliers because filings mention supplier awards they gave) but cannot verify every remaining estimate. Company names resolve through `companies.name` and aliases only; former names (for example Shriram Pistons) are not found.

- The SPLC estimator copies one company-level aggregate to many edges (BEL: 90 % of revenue on every customer). The assistant suppresses shared estimates; the SPLC pane and momentum weights do not.
- Corporate actions start in late 2026 and bonuses are not ingested; demo ledgers avoid affected names. Grandfathering needs the 31 Jan 2018 FMV, which is not stored, so pre-2018 lots are reported as inexact.
- Surcharge, basic-exemption shortfall and rebates are not modelled; estimates state this.
- Conversation access is by unguessable id only. Real portfolios need authentication, tenant isolation, consent and retention controls first.
- Answers can still contain unsupported wording (for example a wrong year for the 1.25 lakh exemption change); the eval catches the patterns it encodes, not every factual slip.

## Deployment

No migration, no new service: web gains routes, Redis keys under `bot:` and a `chat` budget class. Vercel is linked to GitHub with `main` as the production branch; `feat/bot` previews build green. Merging to `main` deploys production web and, because `packages/**` changed, triggers `.github/workflows/worker.yml`, which redeploys the worker (its behaviour is unchanged: new optional config and an unused budget class). Production already has every required variable (`CEREBRAS_API_KEY`, `REDIS_URL`, `DATABASE_URL`, `API_KEY`, `ADMIN_API_KEY`); `BOT_*` and `LLM_BUDGET_CHAT` have safe defaults. Rollback: set `BOT_ENABLED=false` (503 on chat) or promote the previous Vercel deployment.

After deploy, verify: `/bot` renders; a portfolio question streams with a chart; Stop cancels; a second turn keeps context; `/admin/traces` shows the turns; `LLM_BUDGET_CHAT` usage in Redis moves; worker heartbeat stays green.
