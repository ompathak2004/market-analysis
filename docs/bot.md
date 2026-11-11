# /bot — financial intelligence assistant

Conversational assistant over the terminal's own data: demo portfolios, prices, fundamentals, NSE filings with triage, broker research, the SPLC supply-chain graph, graph-derived signals, alt-data and a versioned Indian capital-gains engine. The model explains numbers; deterministic code computes them.

## Decisions (2026-11-12)

| Topic | Decision | Why |
| --- | --- | --- |
| Runtime | Custom loop in `packages/agent` over Cerebras OpenAI-compatible `/chat/completions` with SSE | No framework needed for ~15 read-only tools; full control of validation, budgets and tool-call leaks. AI SDK's Cerebras provider had multi-step reasoning bugs; Mastra needs a storage adapter we do not have. |
| Boundary | `@ma/agent` depends on `@ma/core` and `zod` only. Web wires tools to `@/server/queries`. | Web still never loads `@ma/llm` or pg-boss; interactive inference is a separate, bounded path with its own budget. |
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
