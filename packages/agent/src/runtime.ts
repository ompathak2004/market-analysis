import { estimateTokens } from "@ma/llm";
import type { TurnStatus, TurnTool } from "./context.js";
import {
  type ChatMessage,
  type Provider,
  ProviderError,
  type ToolCallMessage,
  type Usage,
} from "./provider.js";
import { type AgentTool, type Citation, Citations, toolSchemas } from "./tools.js";
import { hashText, redact, type Trace } from "./trace.js";
import { checkViz, type VizSpec } from "./viz.js";

export interface RuntimeLimits {
  maxSteps: number;
  maxToolCalls: number;
  deadlineMs: number;
  maxOutputTokens: number;
  toolResultChars: number;
  totalToolChars: number;
}

export const DEFAULT_LIMITS: RuntimeLimits = {
  maxSteps: 3,
  maxToolCalls: 8,
  deadlineMs: 55_000,
  maxOutputTokens: 1_400,
  toolResultChars: 5_000,
  totalToolChars: 16_000,
};

export type FailureCategory =
  | "rate_limited"
  | "budget_exhausted"
  | "provider_unavailable"
  | "timeout"
  | "cancelled"
  | "invalid_model_output"
  | "internal";

export class BudgetError extends Error {
  constructor(
    readonly kind: "budget_exhausted" | "rate_limited",
    message: string,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
  }
}

export interface TokenBudget {
  reserve(tokens: number): Promise<unknown>;
  settle(reservation: unknown, actual: number): Promise<void>;
}

export type AgentEvent =
  | { type: "status"; stage: "thinking" | "tools" | "answering"; step: number }
  | { type: "text"; delta: string }
  | { type: "tool_start"; callId: string; name: string; args: Record<string, unknown> }
  | { type: "tool_end"; callId: string; name: string; ok: boolean; ms: number; summary: string }
  | { type: "chart"; spec: VizSpec }
  | { type: "citations"; citations: Citation[] };

export interface RunParams {
  provider: Provider;
  models: { primary: string; fallback: string | null };
  system: string;
  history: ChatMessage[];
  user: string;
  tools: readonly AgentTool[];
  portfolioId: string | null;
  limits?: Partial<RuntimeLimits>;
  budget: TokenBudget | null;
  trace: Trace;
  signal: AbortSignal;
  emit(event: AgentEvent): void;
}

export interface RunResult {
  text: string;
  status: TurnStatus;
  failure: FailureCategory | null;
  failureMessage: string | null;
  tools: TurnTool[];
  citations: Citation[];
  charts: VizSpec[];
  invalidCitations: string[];
  model: string | null;
  steps: number;
  usage: Usage & { calls: number };
  ttftMs: number | null;
}

interface StepOutput {
  text: string;
  reasoning: string;
  calls: ToolCallMessage[];
  finish: string | null;
  usage: Usage | null;
  model: string;
  leaked: boolean;
}

class RunAbort extends Error {
  constructor(
    readonly category: FailureCategory,
    message: string,
  ) {
    super(message);
  }
}

const LEAK = /^\s*(\{|\[|<\||<tool|```json|```\s*\{)/;
const CITE = /\[(S\d{1,3})\]/g;

function failureOf(
  err: unknown,
  signal: AbortSignal,
  userSignal: AbortSignal,
): [FailureCategory, string] {
  if (err instanceof RunAbort) return [err.category, err.message];
  if (userSignal.aborted) return ["cancelled", "cancelled by user"];
  if (signal.aborted) return ["timeout", "request deadline exceeded"];
  if (err instanceof BudgetError) return [err.kind, err.message];
  if (err instanceof ProviderError) {
    if (err.kind === "rate_limited") return ["rate_limited", err.message];
    if (err.kind === "timeout") return ["timeout", err.message];
    return ["provider_unavailable", err.message];
  }
  return ["internal", err instanceof Error ? err.message : String(err)];
}

export async function runAgent(p: RunParams): Promise<RunResult> {
  const limits = { ...DEFAULT_LIMITS, ...p.limits };
  const deadline = AbortSignal.any([p.signal, AbortSignal.timeout(limits.deadlineMs)]);
  const schemas = toolSchemas(p.tools);
  const byName = new Map(p.tools.map((t) => [t.name, t]));
  const citations = new Citations();
  const charts: VizSpec[] = [];
  const turnTools: TurnTool[] = [];
  const usage = { promptTokens: 0, completionTokens: 0, cachedTokens: 0, calls: 0 };
  const messages: ChatMessage[] = [
    { role: "system", content: p.system },
    ...p.history,
    { role: "user", content: p.user },
  ];
  const toolTokens = estimateTokens(JSON.stringify(schemas));
  let text = "";
  let model: string | null = null;
  let ttftMs: number | null = null;
  let toolCalls = 0;
  let toolChars = 0;
  let steps = 0;
  let leakRetried = false;

  const root = p.trace.span("agent.run", {
    "gen_ai.system": p.provider.name,
    "agent.tools.available": p.tools.length,
    "agent.limits.max_steps": limits.maxSteps,
    "agent.limits.max_tool_calls": limits.maxToolCalls,
    "agent.context.system_tokens": estimateTokens(p.system),
    "agent.context.history_messages": p.history.length,
    "agent.context.tool_schema_tokens": toolTokens,
    "agent.portfolio_id": p.portfolioId,
  });

  const emitText = (delta: string) => {
    if (!delta) return;
    ttftMs ??= p.trace.elapsed();
    text += delta;
    p.emit({ type: "text", delta });
  };

  const callModel = async (step: number, toolChoice: "auto" | "none"): Promise<StepOutput> => {
    const route = [
      p.models.primary,
      ...(p.models.fallback ? [p.models.fallback] : [p.models.primary]),
    ];
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < route.length; attempt++) {
      const m = route[attempt] as string;
      const span = p.trace.span(
        "gen_ai.chat",
        {
          "gen_ai.request.model": m,
          "agent.step": step,
          "agent.attempt": attempt + 1,
          "gen_ai.tool_choice": toolChoice,
        },
        root,
      );
      const estimate =
        estimateTokens(JSON.stringify(messages)) + toolTokens + limits.maxOutputTokens;
      span.set({ "agent.context.estimated_tokens": estimate });
      let reservation: unknown = null;
      let emitted = false;
      try {
        if (p.budget) reservation = await p.budget.reserve(estimate);
        const out: StepOutput = {
          text: "",
          reasoning: "",
          calls: [],
          finish: null,
          usage: null,
          model: m,
          leaked: false,
        };
        const pending: Array<{ id: string; name: string; args: string }> = [];
        let head = "";
        let decided = false;
        let firstToken: number | null = null;
        for await (const d of p.provider.stream({
          model: m,
          messages,
          tools: schemas,
          toolChoice,
          maxOutputTokens: limits.maxOutputTokens,
          temperature: 0.2,
          signal: deadline,
        })) {
          if (d.type === "reasoning") out.reasoning += d.text;
          else if (d.type === "text") {
            firstToken ??= p.trace.elapsed();
            out.text += d.text;
            if (!decided) {
              head += d.text;
              if (head.trim().length < 12) continue;
              decided = true;
              out.leaked = LEAK.test(head);
              if (!out.leaked) {
                emitted = true;
                emitText(head);
              }
            } else if (!out.leaked) {
              emitText(d.text);
            }
          } else if (d.type === "tool") {
            firstToken ??= p.trace.elapsed();
            const slot = pending[d.index] ?? { id: "", name: "", args: "" };
            pending[d.index] = slot;
            if (d.id) slot.id = d.id;
            if (d.name) slot.name = d.name;
            slot.args += d.args;
          } else {
            out.finish = d.reason;
            out.usage = d.usage;
          }
        }
        if (!decided && head) {
          out.leaked = LEAK.test(head);
          if (!out.leaked) {
            emitted = true;
            emitText(head);
          }
        }
        out.calls = pending
          .filter((c) => c?.name)
          .map((c, i) => ({
            id: c.id || `call_${step}_${i}`,
            type: "function" as const,
            function: { name: c.name, arguments: c.args || "{}" },
          }));
        const u = out.usage ?? {
          promptTokens: estimate - limits.maxOutputTokens,
          completionTokens: estimateTokens(out.text + out.reasoning),
          cachedTokens: 0,
        };
        usage.promptTokens += u.promptTokens;
        usage.completionTokens += u.completionTokens;
        usage.cachedTokens += u.cachedTokens;
        usage.calls++;
        if (p.budget && reservation != null)
          await p.budget.settle(reservation, u.promptTokens + u.completionTokens);
        span.end("ok", {
          "gen_ai.response.model": m,
          "gen_ai.response.finish_reasons": [out.finish ?? "unknown"],
          "gen_ai.usage.input_tokens": u.promptTokens,
          "gen_ai.usage.output_tokens": u.completionTokens,
          "gen_ai.usage.cached_tokens": u.cachedTokens,
          "gen_ai.usage.estimated": out.usage == null,
          "agent.ttft_ms": firstToken == null ? null : firstToken - span.span.startMs,
          "agent.tool_calls": out.calls.map((c) => c.function.name),
          "agent.text_chars": out.text.length,
          "agent.leaked_tool_text": out.leaked,
        });
        model = m;
        return out;
      } catch (err) {
        lastErr = err;
        if (p.budget && reservation != null)
          await p.budget.settle(reservation, 0).catch(() => undefined);
        const retryable =
          !emitted &&
          !deadline.aborted &&
          ((err instanceof ProviderError && err.retryable) ||
            (err instanceof BudgetError && err.kind === "rate_limited"));
        span.end("error", {
          "error.type":
            err instanceof ProviderError
              ? err.kind
              : err instanceof BudgetError
                ? err.kind
                : "error",
          "error.message": err instanceof Error ? err.message.slice(0, 300) : String(err),
          "gen_ai.provider.request_id": err instanceof ProviderError ? err.requestId : null,
          "agent.will_retry": retryable && attempt + 1 < route.length,
        });
        if (!retryable || attempt + 1 >= route.length) throw err;
        const hinted =
          err instanceof ProviderError || err instanceof BudgetError ? (err.retryAfterMs ?? 0) : 0;
        const wait = Math.min(4_000, Math.max(750, hinted));
        await new Promise((r) => setTimeout(r, wait));
      }
    }
    throw lastErr;
  };

  const runTool = async (call: ToolCallMessage): Promise<string> => {
    const tool = byName.get(call.function.name);
    const span = p.trace.span(
      "agent.tool",
      {
        "gen_ai.tool.name": call.function.name,
        "gen_ai.tool.call.id": call.id,
        "agent.tool.args_hash": hashText(call.function.arguments),
      },
      root,
    );
    const started = p.trace.elapsed();
    const fail = (kind: string, message: string, args: Record<string, unknown> = {}) => {
      span.end("error", { "error.type": kind, "error.message": message.slice(0, 300) });
      turnTools.push({
        callId: call.id,
        name: call.function.name,
        args,
        ok: false,
        summary: message.slice(0, 200),
      });
      p.emit({
        type: "tool_end",
        callId: call.id,
        name: call.function.name,
        ok: false,
        ms: p.trace.elapsed() - started,
        summary: message,
      });
      return JSON.stringify({ ok: false, error: message });
    };
    if (!tool)
      return fail(
        "unknown_tool",
        `unknown tool ${call.function.name}; use one of: ${[...byName.keys()].join(", ")}`,
      );
    let raw: unknown;
    try {
      raw = JSON.parse(call.function.arguments || "{}");
    } catch {
      return fail("invalid_json", "arguments were not valid JSON");
    }
    const parsed = tool.input.safeParse(raw);
    const args = (raw && typeof raw === "object" ? redact(raw, 80) : {}) as Record<string, unknown>;
    span.set({ "agent.tool.args": JSON.stringify(args).slice(0, 400) });
    p.emit({ type: "tool_start", callId: call.id, name: tool.name, args });
    if (!parsed.success) {
      const issues = parsed.error.issues
        .slice(0, 4)
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ");
      return fail("invalid_arguments", `invalid arguments: ${issues}`, args);
    }
    const signal = AbortSignal.any([deadline, AbortSignal.timeout(tool.timeoutMs)]);
    try {
      const out = await Promise.race([
        tool.run(parsed.data, {
          signal,
          callId: call.id,
          portfolioId: p.portfolioId,
          cite: (c) => citations.add(c),
        }),
        new Promise<never>((_, reject) =>
          signal.addEventListener(
            "abort",
            () => reject(new Error(`tool timed out after ${tool.timeoutMs} ms`)),
            { once: true },
          ),
        ),
      ]);
      let chartErrors = 0;
      for (const c of out.charts) {
        const v = checkViz(c);
        if (v.ok) {
          charts.push(v.spec);
          p.emit({ type: "chart", spec: v.spec });
        } else {
          chartErrors++;
          span.event("viz.invalid", { error: v.error });
        }
      }
      let content = JSON.stringify({
        ok: true,
        summary: out.summary,
        freshness: out.freshness,
        data: out.data,
      });
      const cap = Math.max(
        800,
        Math.min(limits.toolResultChars, limits.totalToolChars - toolChars),
      );
      const truncated = content.length > cap;
      if (truncated)
        content = `${content.slice(0, cap)}…[truncated ${content.length - cap} chars; ask a narrower question for the rest]`;
      toolChars += content.length;
      span.end("ok", {
        "agent.tool.result_chars": content.length,
        "agent.tool.truncated": truncated,
        "agent.tool.charts": out.charts.length - chartErrors,
        "agent.tool.chart_errors": chartErrors,
        "agent.tool.freshness": out.freshness,
        "agent.tool.latency_ms": p.trace.elapsed() - started,
      });
      turnTools.push({
        callId: call.id,
        name: tool.name,
        args,
        ok: true,
        summary: out.summary.slice(0, 300),
      });
      p.emit({
        type: "tool_end",
        callId: call.id,
        name: tool.name,
        ok: true,
        ms: p.trace.elapsed() - started,
        summary: out.summary,
      });
      return content;
    } catch (err) {
      if (p.signal.aborted) throw err;
      const message = err instanceof Error ? err.message : String(err);
      return fail(signal.aborted ? "timeout" : "tool_error", message, args);
    }
  };

  let status: TurnStatus = "ok";
  let failure: FailureCategory | null = null;
  let failureMessage: string | null = null;
  try {
    for (let step = 0; step < limits.maxSteps; step++) {
      steps = step + 1;
      const last = step === limits.maxSteps - 1 || toolCalls >= limits.maxToolCalls;
      p.emit({ type: "status", stage: step === 0 ? "thinking" : "answering", step });
      const out = await callModel(step, last ? "none" : "auto");
      if (out.leaked && !out.calls.length) {
        if (leakRetried || last)
          throw new RunAbort("invalid_model_output", "model returned tool syntax as text");
        leakRetried = true;
        messages.push({
          role: "user",
          content:
            "Your previous reply contained raw tool-call syntax. Call tools through the tool interface, or answer in plain prose.",
        });
        continue;
      }
      if (!out.calls.length || last) {
        if (!text.trim())
          throw new RunAbort(
            "invalid_model_output",
            `empty answer (finish ${out.finish ?? "unknown"})`,
          );
        break;
      }
      const allowed = out.calls.slice(0, Math.max(0, limits.maxToolCalls - toolCalls));
      const skipped = out.calls.slice(allowed.length);
      toolCalls += allowed.length;
      messages.push({
        role: "assistant",
        content: out.text || null,
        tool_calls: out.calls,
        ...(out.reasoning ? { reasoning: out.reasoning } : {}),
      });
      p.emit({ type: "status", stage: "tools", step });
      const results = await Promise.all(allowed.map(runTool));
      for (const [i, c] of allowed.entries())
        messages.push({ role: "tool", tool_call_id: c.id, content: results[i] as string });
      for (const c of skipped)
        messages.push({
          role: "tool",
          tool_call_id: c.id,
          content: JSON.stringify({
            ok: false,
            error: "tool-call limit reached for this question",
          }),
        });
      if (out.text) emitText("\n\n");
    }
  } catch (err) {
    [failure, failureMessage] = failureOf(err, deadline, p.signal);
    status = failure === "cancelled" ? "cancelled" : text.trim() ? "partial" : "failed";
  }

  const cited = new Set([...text.matchAll(CITE)].map((m) => m[1] as string));
  const invalidCitations = [...cited].filter((id) => !citations.has(id));
  const list = citations.list();
  if (list.length) p.emit({ type: "citations", citations: list });
  root.end(failure && status !== "cancelled" ? "error" : "ok", {
    "agent.status": status,
    "agent.failure": failure,
    "agent.steps": steps,
    "agent.tool_calls": toolCalls,
    "agent.charts": charts.length,
    "agent.citations": list.length,
    "agent.citations.used": [...cited],
    "agent.citations.invalid": invalidCitations,
    "agent.answer_chars": text.length,
    "agent.ttft_ms": ttftMs,
    "gen_ai.usage.input_tokens": usage.promptTokens,
    "gen_ai.usage.output_tokens": usage.completionTokens,
  });
  return {
    text,
    status,
    failure,
    failureMessage,
    tools: turnTools,
    citations: list,
    charts,
    invalidCitations,
    model,
    steps,
    usage,
    ttftMs,
  };
}
