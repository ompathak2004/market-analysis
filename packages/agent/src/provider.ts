export interface ToolCallMessage {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: ToolCallMessage[];
      reasoning?: string;
    }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ToolSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    strict: true;
    parameters: Record<string, unknown>;
  };
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools: ToolSchema[];
  toolChoice: "auto" | "none";
  maxOutputTokens: number;
  temperature: number;
  signal: AbortSignal;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
}

export type StreamDelta =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool"; index: number; id: string | null; name: string | null; args: string }
  | { type: "finish"; reason: string | null; usage: Usage | null };

export type ProviderErrorKind =
  | "rate_limited"
  | "unavailable"
  | "bad_request"
  | "auth"
  | "timeout"
  | "network";

export class ProviderError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
    readonly status: number | null,
    readonly retryAfterMs: number | null,
    readonly requestId: string | null,
  ) {
    super(message);
  }

  get retryable(): boolean {
    return this.kind === "rate_limited" || this.kind === "unavailable" || this.kind === "network";
  }
}

export interface Provider {
  readonly name: string;
  stream(req: ChatRequest): AsyncGenerator<StreamDelta>;
}

interface Chunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      reasoning?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

function classify(status: number): ProviderErrorKind {
  if (status === 429) return "rate_limited";
  if (status === 401 || status === 403) return "auth";
  if (status >= 500) return "unavailable";
  return "bad_request";
}

export class OpenAiCompatibleProvider implements Provider {
  private readonly fetchImpl: typeof fetch;

  constructor(
    readonly name: string,
    private readonly opts: { apiKey: string; baseUrl: string; fetch?: typeof fetch },
  ) {
    this.fetchImpl = opts.fetch ?? fetch;
  }

  async *stream(req: ChatRequest): AsyncGenerator<StreamDelta> {
    const body = JSON.stringify({
      model: req.model,
      stream: true,
      messages: req.messages,
      ...(req.tools.length
        ? { tools: req.tools, tool_choice: req.toolChoice, parallel_tool_calls: true }
        : {}),
      max_completion_tokens: req.maxOutputTokens,
      temperature: req.temperature,
      ...(req.model.startsWith("gpt-oss") ? { reasoning_effort: "low" } : {}),
    });
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.opts.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.opts.apiKey}`,
          "content-type": "application/json",
        },
        body,
        signal: req.signal,
      });
    } catch (err) {
      const aborted = req.signal.aborted;
      throw new ProviderError(
        aborted ? "timeout" : "network",
        aborted ? "request aborted" : err instanceof Error ? err.message : String(err),
        null,
        null,
        null,
      );
    }
    const requestId = res.headers.get("x-request-id");
    if (!res.ok || !res.body) {
      const text = (await res.text().catch(() => "")).slice(0, 300);
      const retryAfter = Number(res.headers.get("retry-after"));
      throw new ProviderError(
        classify(res.status),
        `status ${res.status}: ${text}`,
        res.status,
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1_000 : null,
        requestId,
      );
    }
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    let finished = false;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        let nl = buffer.indexOf("\n");
        while (nl >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          nl = buffer.indexOf("\n");
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") continue;
          let chunk: Chunk;
          try {
            chunk = JSON.parse(data) as Chunk;
          } catch {
            continue;
          }
          const choice = chunk.choices?.[0];
          const d = choice?.delta;
          if (d?.reasoning) yield { type: "reasoning", text: d.reasoning };
          if (d?.content) yield { type: "text", text: d.content };
          for (const t of d?.tool_calls ?? []) {
            yield {
              type: "tool",
              index: t.index ?? 0,
              id: t.id ?? null,
              name: t.function?.name ?? null,
              args: t.function?.arguments ?? "",
            };
          }
          if (choice?.finish_reason || chunk.usage) {
            finished = true;
            yield {
              type: "finish",
              reason: choice?.finish_reason ?? null,
              usage: chunk.usage
                ? {
                    promptTokens: chunk.usage.prompt_tokens ?? 0,
                    completionTokens: chunk.usage.completion_tokens ?? 0,
                    cachedTokens: chunk.usage.prompt_tokens_details?.cached_tokens ?? 0,
                  }
                : null,
            };
          }
        }
      }
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      throw new ProviderError(
        req.signal.aborted ? "timeout" : "network",
        err instanceof Error ? err.message : String(err),
        null,
        null,
        requestId,
      );
    } finally {
      reader.releaseLock();
    }
    if (!finished)
      throw new ProviderError("network", "stream ended without finish", null, null, requestId);
  }
}
