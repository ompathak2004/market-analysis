import { deadlineSignal, type Logger, remainingMs, sleep, UpstreamError } from "@ma/core";
import type { z } from "zod";
import type { LlmBudget, LlmBudgetClass, LlmReservation } from "./budget.js";
import { LlmInvalidOutput, LlmPromptTooLarge } from "./errors.js";
import { type JsonSchema, toStrictJsonSchema } from "./schema.js";

export const PROMPT_TOKEN_LIMIT = 12_000;
const CHARS_PER_TOKEN = 3.5;
const BACKOFF_MS = [1_000, 3_000];
const HTTP_ATTEMPTS = 3;

export const estimateTokens = (text: string): number => Math.ceil(text.length / CHARS_PER_TOKEN);

export interface JsonRequest<T> {
  name: string;
  system: string;
  user: string;
  schema: z.ZodType<T, z.ZodTypeDef, unknown>;
  maxOutputTokens?: number;
  temperature?: number;
  model?: "primary" | "fallback";
  budgetClass?: LlmBudgetClass;
}

export interface JsonResult<T> {
  data: T;
  model: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  attempts: number;
}

export interface LlmUsage {
  kind: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  ok: boolean;
}

export interface LlmClientOptions {
  apiKey: string;
  model: string;
  fallbackModel: string;
  logger: Logger;
  budget?: LlmBudget | null;
  record?: (usage: LlmUsage) => Promise<void> | void;
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

interface Completion {
  content: string;
  finishReason: string | null;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  attempts: number;
}

interface ChatResponse {
  choices?: Array<{ message?: { content?: string | null }; finish_reason?: string | null }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export class LlmClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;

  constructor(private readonly opts: LlmClientOptions) {
    this.baseUrl = opts.baseUrl ?? "https://api.cerebras.ai/v1";
    this.fetchImpl = opts.fetch ?? fetch;
    this.sleepImpl = opts.sleep ?? sleep;
  }

  get model(): string {
    return this.opts.model;
  }

  get fallbackModel(): string {
    return this.opts.fallbackModel;
  }

  get budget(): LlmBudget | null {
    return this.opts.budget ?? null;
  }

  async complete<T>(req: JsonRequest<T>): Promise<JsonResult<T>> {
    const estimated = estimateTokens(req.system + req.user);
    if (estimated > PROMPT_TOKEN_LIMIT) {
      throw new LlmPromptTooLarge(req.name, estimated, PROMPT_TOKEN_LIMIT);
    }
    const schema = toStrictJsonSchema(req.schema);
    const primary = req.model === "fallback" ? this.opts.fallbackModel : this.opts.model;
    const steps = [
      { model: primary, feedback: false },
      { model: primary, feedback: true },
      ...(this.opts.fallbackModel !== primary
        ? [{ model: this.opts.fallbackModel, feedback: true }]
        : []),
    ];
    const totals = { promptTokens: 0, completionTokens: 0, latencyMs: 0, attempts: 0 };
    let lastError = "";
    for (const step of steps) {
      const user =
        step.feedback && lastError
          ? `${req.user}\n\nYour previous response was rejected: ${lastError}\nReturn only JSON that satisfies the schema.`
          : req.user;
      const c = await this.post(step.model, req, user, schema);
      totals.promptTokens += c.promptTokens;
      totals.completionTokens += c.completionTokens;
      totals.latencyMs += c.latencyMs;
      totals.attempts += c.attempts;
      const parsed = parseOutput(c.content, req.schema);
      await this.track({
        kind: req.name,
        model: step.model,
        promptTokens: c.promptTokens,
        completionTokens: c.completionTokens,
        latencyMs: c.latencyMs,
        ok: parsed.ok,
      });
      if (parsed.ok) return { data: parsed.data, model: step.model, ...totals };
      lastError = c.finishReason === "length" ? `output truncated; ${parsed.error}` : parsed.error;
      this.opts.logger.warn({ name: req.name, model: step.model, error: lastError }, "llm invalid");
    }
    throw new LlmInvalidOutput(req.name, lastError);
  }

  private async post<T>(
    model: string,
    req: JsonRequest<T>,
    user: string,
    schema: JsonSchema,
  ): Promise<Completion> {
    const maxOutputTokens = req.maxOutputTokens ?? 1_500;
    const body = JSON.stringify({
      model,
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: user },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: req.name, strict: true, schema },
      },
      max_completion_tokens: maxOutputTokens,
      temperature: req.temperature ?? 0.2,
      ...(model.startsWith("gpt-oss") ? { reasoning_effort: "low" } : {}),
    });
    const estimated = estimateTokens(req.system + user) + maxOutputTokens;
    let lastError = "";
    for (let attempt = 1; attempt <= HTTP_ATTEMPTS; attempt++) {
      const reservation = await this.opts.budget?.reserve(estimated, req.budgetClass ?? "insights");
      const started = Date.now();
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.opts.apiKey}`,
            "content-type": "application/json",
          },
          body,
          signal: deadlineSignal(this.opts.timeoutMs ?? 60_000),
        });
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        await this.failed(req.name, model, started);
        if (!(await this.backoff(attempt, null))) break;
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        lastError = `status ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`;
        await this.settle(reservation, 0);
        await this.failed(req.name, model, started);
        if (!(await this.backoff(attempt, res.headers.get("retry-after")))) break;
        continue;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        await this.settle(reservation, 0);
        await this.failed(req.name, model, started);
        throw new UpstreamError("cerebras", `status ${res.status}: ${text.slice(0, 300)}`, {
          model,
          name: req.name,
        });
      }
      const json = (await res.json()) as ChatResponse;
      const latencyMs = Date.now() - started;
      const promptTokens = json.usage?.prompt_tokens ?? 0;
      const completionTokens = json.usage?.completion_tokens ?? 0;
      await this.settle(reservation, promptTokens + completionTokens);
      const choice = json.choices?.[0];
      return {
        content: choice?.message?.content ?? "",
        finishReason: choice?.finish_reason ?? null,
        promptTokens,
        completionTokens,
        latencyMs,
        attempts: attempt,
      };
    }
    throw new UpstreamError("cerebras", lastError || "request failed", { model, name: req.name });
  }

  private async backoff(attempt: number, retryAfter: string | null): Promise<boolean> {
    if (attempt >= HTTP_ATTEMPTS) return false;
    const base = BACKOFF_MS[attempt - 1] ?? 3_000;
    const hinted = retryAfter ? Number(retryAfter) * 1_000 : 0;
    const wait = Math.min(10_000, Math.max(base, Number.isFinite(hinted) ? hinted : 0));
    if (wait + (this.opts.timeoutMs ?? 60_000) > remainingMs()) return false;
    await this.sleepImpl(wait);
    return true;
  }

  private async settle(reservation: LlmReservation | undefined, actual: number): Promise<void> {
    if (reservation) await this.opts.budget?.settle(reservation, actual);
  }

  private async failed(kind: string, model: string, started: number): Promise<void> {
    await this.track({
      kind,
      model,
      promptTokens: 0,
      completionTokens: 0,
      latencyMs: Date.now() - started,
      ok: false,
    });
  }

  private async track(usage: LlmUsage): Promise<void> {
    if (!this.opts.record) return;
    try {
      await this.opts.record(usage);
    } catch (err) {
      this.opts.logger.warn({ err }, "llm usage record failed");
    }
  }
}

type Parsed<T> = { ok: true; data: T } | { ok: false; error: string };

export function parseOutput<T>(
  content: string,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
): Parsed<T> {
  const text = content
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```$/, "")
    .trim();
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: "response was not valid JSON" };
  }
  const result = schema.safeParse(raw);
  if (result.success) return { ok: true, data: result.data };
  const issues = result.error.issues
    .slice(0, 6)
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
  return { ok: false, error: issues };
}
