import { createLogger, UpstreamError, withDeadline } from "@ma/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { LlmBudget, LlmReservation } from "./budget.js";
import { LlmClient, type LlmUsage } from "./client.js";
import { LlmInvalidOutput, LlmPromptTooLarge } from "./errors.js";

const schema = z.object({ answer: z.string(), score: z.number().min(0).max(10) });
const logger = createLogger("llm-test", "silent");

type Reply = { status: number; content?: string; finish?: string };

function fakeBudget() {
  const log: Array<[string, number]> = [];
  const budget = {
    async reserve(tokens: number): Promise<LlmReservation> {
      log.push(["reserve", tokens]);
      return { key: "k", tokens };
    },
    async settle(r: LlmReservation, actual: number): Promise<number> {
      log.push(["settle", actual - r.tokens]);
      return 0;
    },
  } as unknown as LlmBudget;
  return { budget, log };
}

function harness(replies: Reply[], budget?: LlmBudget) {
  const calls: Array<{ model: string; user: string; body: Record<string, unknown> }> = [];
  const usage: LlmUsage[] = [];
  const sleeps: number[] = [];
  const fetchMock = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as {
      model: string;
      messages: Array<{ content: string }>;
    };
    calls.push({ model: body.model, user: body.messages[1]?.content ?? "", body });
    const r = replies.shift();
    if (!r) throw new Error("unexpected call");
    if (r.status !== 200) return new Response("busy", { status: r.status });
    return Response.json({
      choices: [{ message: { content: r.content ?? "" }, finish_reason: r.finish ?? "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 20 },
    });
  }) as unknown as typeof fetch;
  const client = new LlmClient({
    apiKey: "k",
    model: "gpt-oss-120b",
    fallbackModel: "qwen-3.8-27b",
    logger,
    fetch: fetchMock,
    budget: budget ?? null,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    record: (u) => {
      usage.push(u);
    },
  });
  return { client, calls, usage, sleeps };
}

const req = { name: "probe", system: "sys", user: "question", schema };
const good = JSON.stringify({ answer: "ok", score: 7 });

describe("LlmClient", () => {
  it("sends a strict json_schema request and returns parsed data", async () => {
    const h = harness([{ status: 200, content: good }]);
    const r = await h.client.complete(req);
    expect(r.data).toEqual({ answer: "ok", score: 7 });
    expect(r.model).toBe("gpt-oss-120b");
    expect(r.promptTokens).toBe(100);
    const rf = h.calls[0]?.body.response_format as {
      type: string;
      json_schema: { name: string; strict: boolean; schema: { additionalProperties: boolean } };
    };
    expect(rf.type).toBe("json_schema");
    expect(rf.json_schema.strict).toBe(true);
    expect(rf.json_schema.schema.additionalProperties).toBe(false);
    expect(h.usage).toEqual([expect.objectContaining({ kind: "probe", ok: true })]);
  });

  it("retries 429 and 5xx with 1 s then 3 s backoff", async () => {
    const h = harness([{ status: 429 }, { status: 503 }, { status: 200, content: good }]);
    const r = await h.client.complete(req);
    expect(r.attempts).toBe(3);
    expect(h.sleeps).toEqual([1_000, 3_000]);
    expect(h.usage.map((u) => u.ok)).toEqual([false, false, true]);
  });

  it("gives up after three transport failures", async () => {
    const h = harness([{ status: 500 }, { status: 502 }, { status: 503 }]);
    await expect(h.client.complete(req)).rejects.toBeInstanceOf(UpstreamError);
  });

  it("stops retrying when a backoff plus attempt would pass the job deadline", async () => {
    const h = harness([{ status: 429 }, { status: 200, content: good }]);
    await expect(
      withDeadline(Date.now() + 30_000, () => h.client.complete(req)),
    ).rejects.toBeInstanceOf(UpstreamError);
    expect(h.calls).toHaveLength(1);
    expect(h.sleeps).toEqual([]);
  });

  it("reserves the estimated spend up front and settles to actual usage", async () => {
    const { budget, log } = fakeBudget();
    const h = harness([{ status: 503 }, { status: 200, content: good }], budget);
    await h.client.complete(req);
    const reserved = log[0]?.[1] ?? 0;
    expect(reserved).toBeGreaterThan(1_500);
    expect(log).toEqual([
      ["reserve", reserved],
      ["settle", -reserved],
      ["reserve", reserved],
      ["settle", 120 - reserved],
    ]);
  });

  it("does not retry other client errors", async () => {
    const h = harness([{ status: 400 }]);
    await expect(h.client.complete(req)).rejects.toBeInstanceOf(UpstreamError);
    expect(h.calls).toHaveLength(1);
  });

  it("retries once with the validation error, then succeeds", async () => {
    const h = harness([
      { status: 200, content: JSON.stringify({ answer: "ok", score: 42 }) },
      { status: 200, content: good },
    ]);
    const r = await h.client.complete(req);
    expect(r.data.score).toBe(7);
    expect(h.calls[1]?.user).toContain("score");
    expect(h.calls[1]?.model).toBe("gpt-oss-120b");
  });

  it("falls back to the fallback model after two invalid outputs", async () => {
    const h = harness([
      { status: 200, content: "not json" },
      { status: 200, content: "{}" },
      { status: 200, content: good },
    ]);
    const r = await h.client.complete(req);
    expect(r.model).toBe("qwen-3.8-27b");
    expect(h.calls.map((c) => c.model)).toEqual(["gpt-oss-120b", "gpt-oss-120b", "qwen-3.8-27b"]);
    expect(h.calls[2]?.body.reasoning_effort).toBeUndefined();
  });

  it("throws LlmInvalidOutput when the fallback is invalid too", async () => {
    const h = harness([
      { status: 200, content: "{}" },
      { status: 200, content: "{}" },
      { status: 200, content: "{", finish: "length" },
    ]);
    await expect(h.client.complete(req)).rejects.toBeInstanceOf(LlmInvalidOutput);
    expect(h.usage.every((u) => !u.ok)).toBe(true);
  });

  it("strips code fences around json", async () => {
    const h = harness([{ status: 200, content: `\`\`\`json\n${good}\n\`\`\`` }]);
    expect((await h.client.complete(req)).data.answer).toBe("ok");
  });

  it("rejects prompts above the token guard without calling", async () => {
    const h = harness([]);
    await expect(h.client.complete({ ...req, user: "x".repeat(50_000) })).rejects.toBeInstanceOf(
      LlmPromptTooLarge,
    );
    expect(h.calls).toHaveLength(0);
  });
});
