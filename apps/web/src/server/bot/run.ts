import { randomUUID } from "node:crypto";
import {
  type AgentEvent,
  appendTurn,
  assembleContext,
  BudgetError,
  type Conversation,
  DEMO_PORTFOLIOS,
  demoPortfolio,
  hashText,
  newConversation,
  OpenAiCompatibleProvider,
  PROMPT_VERSION,
  type RunParams,
  type RunResult,
  runAgent,
  systemPrompt,
  type TokenBudget,
  Trace,
  type Turn,
} from "@ma/agent";
import { RateLimitedError } from "@ma/core";
import { LlmBudget, LlmBudgetExceeded, type LlmReservation } from "@ma/llm";
import type { AppContext } from "../context";
import { BotStore } from "./store";
import { botTools } from "./tools";

const PRICE_PER_M: Record<string, { input: number; output: number }> = {
  "gpt-oss-120b": { input: 0.35, output: 0.75 },
  "qwen-3.8-27b": { input: 0.99, output: 1.49 },
};

export type BotEvent =
  | { type: "meta"; conversationId: string; turnId: string; traceId: string; promptVersion: string }
  | AgentEvent
  | {
      type: "done";
      status: RunResult["status"];
      failure: RunResult["failure"];
      message: string | null;
      model: string | null;
      ttftMs: number | null;
      usage: RunResult["usage"];
      invalidCitations: string[];
    };

export interface ChatInput {
  conversationId: string | null;
  requestId: string;
  portfolioId: string | null;
  message: string;
  ip: string;
}

const budgets = new Map<string, LlmBudget>();

function chatBudget(app: AppContext, maxWaitMs: number): TokenBudget {
  let b = budgets.get(String(maxWaitMs));
  if (!b) {
    b = new LlmBudget(app.redis, {
      rpm: app.config.CEREBRAS_RPM,
      dailyTokens: app.config.LLM_DAILY_TOKEN_BUDGET,
      classTokens: app.config.LLM_BUDGET_CHAT ? { chat: app.config.LLM_BUDGET_CHAT } : {},
      maxWaitMs,
      attemptMs: 0,
    });
    budgets.set(String(maxWaitMs), b);
  }
  const budget = b;
  return {
    async reserve(tokens) {
      try {
        return await budget.reserve(tokens, "chat");
      } catch (err) {
        if (err instanceof LlmBudgetExceeded)
          throw new BudgetError("budget_exhausted", "daily assistant token budget is used up");
        if (err instanceof RateLimitedError)
          throw new BudgetError(
            "rate_limited",
            "model capacity is busy",
            Number(err.details?.retryAfterMs) || null,
          );
        throw err;
      }
    },
    async settle(reservation, actual) {
      await budget.settle(reservation as LlmReservation, actual);
    },
  };
}

const FAILURE_COPY: Record<string, string> = {
  rate_limited: "The model is at capacity right now. Wait about a minute and retry.",
  budget_exhausted: "Today's assistant budget is used up. It resets at midnight UTC.",
  provider_unavailable: "The model provider is unavailable. Retry shortly.",
  timeout: "The request took too long and was stopped. Try a narrower question.",
  invalid_model_output: "The model returned an unusable answer. Retry or rephrase.",
  internal: "Something went wrong while answering.",
};

export class ChatConflict extends Error {}

export function turnParams(
  app: AppContext,
  conversation: Conversation,
  portfolioId: string | null,
  message: string,
  trace: Trace,
  signal: AbortSignal,
  emit: (e: AgentEvent) => void,
  opts: { model?: string; fallback?: string | null; maxWaitMs?: number } = {},
): RunParams {
  const portfolio = portfolioId ? demoPortfolio(portfolioId) : null;
  const ctxSpan = trace.span("agent.context");
  const assembled = assembleContext(conversation, portfolio?.id ?? null);
  const system = systemPrompt({
    today: new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10),
    portfolio: portfolio && {
      id: portfolio.id,
      name: portfolio.name,
      benchmark: portfolio.benchmark,
    },
    portfolios: DEMO_PORTFOLIOS.map((p) => ({ id: p.id, name: p.name })),
    memory: assembled.memory,
    portfolioChanged: assembled.portfolioChanged,
  });
  ctxSpan.end("ok", {
    "agent.context.stored_turns": assembled.stats.storedTurns,
    "agent.context.verbatim_turns": assembled.stats.verbatim,
    "agent.context.compacted_turns": assembled.stats.compacted,
    "agent.context.dropped_turns": assembled.stats.dropped,
    "agent.context.history_tokens": assembled.stats.tokens,
    "agent.context.portfolio_changed": assembled.portfolioChanged != null,
  });
  const fallback =
    opts.fallback !== undefined
      ? opts.fallback
      : (app.config.BOT_FALLBACK_MODEL ?? app.config.CEREBRAS_FALLBACK_MODEL);
  return {
    provider: new OpenAiCompatibleProvider("cerebras", {
      apiKey: app.config.CEREBRAS_API_KEY,
      baseUrl: "https://api.cerebras.ai/v1",
    }),
    models: { primary: opts.model ?? app.config.BOT_MODEL, fallback },
    system,
    history: assembled.history,
    user: message,
    tools: botTools(app, conversation),
    portfolioId: portfolio?.id ?? null,
    citationOffset: Math.max(
      0,
      ...conversation.turns.flatMap((t) => t.citations.map((c) => Number(c.id.slice(1)) || 0)),
    ),
    budget: chatBudget(app, opts.maxWaitMs ?? 15_000),
    trace,
    signal,
    emit,
  };
}

export async function prepareChat(app: AppContext, input: ChatInput) {
  const store = new BotStore(app.redis);
  if (!(await store.claimRequest(input.requestId))) throw new ChatConflict("duplicate request");
  const existing = input.conversationId ? await store.load(input.conversationId) : null;
  const conversation = existing ?? newConversation(randomUUID(), input.portfolioId);
  const lockToken = randomUUID();
  if (!(await store.lock(conversation.id, lockToken))) throw new ChatConflict("conversation busy");
  return { store, conversation, lockToken, resumed: existing != null };
}

export async function runChat(
  app: AppContext,
  input: ChatInput,
  prepared: Awaited<ReturnType<typeof prepareChat>>,
  signal: AbortSignal,
  emit: (e: BotEvent) => void,
): Promise<void> {
  const { store, lockToken } = prepared;
  let conversation: Conversation = prepared.conversation;
  const turnId = `t${conversation.turns.length + 1}-${randomUUID().slice(0, 6)}`;
  const portfolio = input.portfolioId ? demoPortfolio(input.portfolioId) : null;
  const trace = new Trace({
    "bot.conversation_id": conversation.id,
    "bot.turn_id": turnId,
    "bot.request_id": input.requestId,
    "bot.prompt_version": PROMPT_VERSION,
    "bot.portfolio_id": portfolio?.id ?? null,
    "bot.resumed": prepared.resumed,
    "bot.message_chars": input.message.length,
    "bot.message_hash": hashText(input.message),
    "bot.message": app.config.BOT_TRACE_CONTENT ? input.message.slice(0, 2_000) : null,
    "client.ip_hash": hashText(input.ip),
  });
  emit({
    type: "meta",
    conversationId: conversation.id,
    turnId,
    traceId: trace.traceId,
    promptVersion: PROMPT_VERSION,
  });
  let result: RunResult | null = null;
  try {
    result = await runAgent(
      turnParams(app, conversation, portfolio?.id ?? null, input.message, trace, signal, emit),
    );
    const turn: Turn = {
      id: turnId,
      at: new Date().toISOString(),
      portfolioId: portfolio?.id ?? null,
      user: input.message,
      assistant: result.text.slice(0, 6_000),
      tools: result.tools,
      citations: result.citations,
      charts: result.charts,
      status: result.status,
      traceId: trace.traceId,
    };
    conversation = appendTurn(conversation, turn);
    await trace.wrap("bot.store.save", {}, () => store.save(conversation));
    emit({
      type: "done",
      status: result.status,
      failure: result.failure,
      message: result.failure
        ? (FAILURE_COPY[result.failure] ?? FAILURE_COPY.internal ?? null)
        : null,
      model: result.model,
      ttftMs: result.ttftMs,
      usage: result.usage,
      invalidCitations: result.invalidCitations.filter(
        (id) => !conversation.turns.some((t) => t.citations.some((c) => c.id === id)),
      ),
    });
  } catch (err) {
    app.logger.error({ err, traceId: trace.traceId }, "bot turn failed");
    emit({
      type: "done",
      status: "failed",
      failure: "internal",
      message: FAILURE_COPY.internal ?? null,
      model: null,
      ttftMs: null,
      usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0, calls: 0 },
      invalidCitations: [],
    });
  } finally {
    await store.unlock(conversation.id, lockToken).catch(() => undefined);
    const price = result?.model ? PRICE_PER_M[result.model] : undefined;
    const cost =
      price && result
        ? (result.usage.promptTokens * price.input + result.usage.completionTokens * price.output) /
          1e6
        : null;
    const record = trace.finish({
      "bot.status": result?.status ?? "failed",
      "bot.failure": result?.failure ?? "internal",
      "bot.failure_message": result?.failureMessage?.slice(0, 300) ?? null,
      "gen_ai.response.model": result?.model ?? null,
      "bot.cost_usd": cost == null ? null : Math.round(cost * 1e6) / 1e6,
      "bot.ttft_ms": result?.ttftMs ?? null,
    });
    app.logger.info(
      {
        traceId: trace.traceId,
        conversationId: conversation.id,
        status: result?.status ?? "failed",
        failure: result?.failure ?? null,
        model: result?.model ?? null,
        durationMs: record.durationMs,
        ttftMs: result?.ttftMs ?? null,
        tools: result?.tools.map((t) => `${t.name}:${t.ok ? "ok" : "err"}`) ?? [],
        tokens: result ? result.usage.promptTokens + result.usage.completionTokens : 0,
      },
      "bot turn",
    );
    await store
      .saveTrace(record, {
        traceId: trace.traceId,
        at: record.startedAt,
        conversationId: conversation.id,
        status: result?.status ?? "failed",
        failure: result?.failure ?? null,
        durationMs: record.durationMs,
      })
      .catch((err) => app.logger.warn({ err }, "bot trace save failed"));
  }
}
