import { toStrictJsonSchema } from "@ma/llm";
import type { z } from "zod";
import type { ToolSchema } from "./provider.js";

export interface Citation {
  id: string;
  kind: "filing" | "policy" | "research" | "document" | "insight" | "dataset" | "statute";
  label: string;
  url: string | null;
  publishedAt: string | null;
  ref: string | null;
}

export interface ToolOutput {
  data: unknown;
  summary: string;
  charts: unknown[];
  freshness: string | null;
}

export interface ToolContext {
  signal: AbortSignal;
  callId: string;
  portfolioId: string | null;
  cite(c: Omit<Citation, "id">): string;
}

export interface AgentTool<I = unknown> {
  name: string;
  description: string;
  input: z.ZodType<I, z.ZodTypeDef, unknown>;
  timeoutMs: number;
  run(input: I, ctx: ToolContext): Promise<ToolOutput>;
}

export function defineTool<I>(tool: AgentTool<I>): AgentTool<unknown> {
  return tool as AgentTool<unknown>;
}

export function toolSchemas(tools: readonly AgentTool[]): ToolSchema[] {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      strict: true,
      parameters: toStrictJsonSchema(t.input),
    },
  }));
}

export class ToolInputError extends Error {}

export class Citations {
  constructor(private readonly offset = 0) {}

  private readonly items: Citation[] = [];
  private readonly byKey = new Map<string, string>();

  add(c: Omit<Citation, "id">): string {
    const key = `${c.kind}|${c.ref ?? ""}|${c.url ?? ""}|${c.label}`;
    const existing = this.byKey.get(key);
    if (existing) return existing;
    const id = `S${this.offset + this.items.length + 1}`;
    this.items.push({ ...c, id });
    this.byKey.set(key, id);
    return id;
  }

  list(): Citation[] {
    return [...this.items];
  }

  has(id: string): boolean {
    return this.items.some((c) => c.id === id);
  }
}
