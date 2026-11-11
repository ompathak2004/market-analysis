import { estimateTokens } from "@ma/llm";
import type { ChatMessage } from "./provider.js";
import type { Citation } from "./tools.js";
import type { VizSpec } from "./viz.js";

export const CONVERSATION_VERSION = 1;

export const CONTEXT_LIMITS = {
  storedTurns: 30,
  verbatimTurns: 4,
  verbatimTokens: 2_400,
  memoryTokens: 900,
  userChars: 2_000,
  assistantChars: 6_000,
} as const;

export interface TurnTool {
  callId: string;
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
  summary: string;
}

export type TurnStatus = "ok" | "partial" | "failed" | "cancelled";

export interface Turn {
  id: string;
  at: string;
  portfolioId: string | null;
  user: string;
  assistant: string;
  tools: TurnTool[];
  citations: Citation[];
  charts: VizSpec[];
  status: TurnStatus;
  traceId: string;
}

export interface Conversation {
  version: number;
  id: string;
  createdAt: string;
  updatedAt: string;
  portfolioId: string | null;
  turns: Turn[];
}

export interface AssembledContext {
  history: ChatMessage[];
  memory: string | null;
  portfolioChanged: { from: string | null; to: string | null } | null;
  stats: {
    storedTurns: number;
    verbatim: number;
    compacted: number;
    dropped: number;
    tokens: number;
  };
}

const clip = (s: string, n: number) => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
};

function argsBrief(args: Record<string, unknown>): string {
  return Object.entries(args)
    .filter(([, v]) => v != null && v !== "")
    .map(([k, v]) => `${k}=${clip(typeof v === "string" ? v : JSON.stringify(v), 40)}`)
    .join(",");
}

function toolNote(t: Turn): string {
  if (!t.tools.length) return "";
  const lines = t.tools.map(
    (x) => `${x.name}(${argsBrief(x.args)}) ${x.ok ? "→" : "failed:"} ${clip(x.summary, 160)}`,
  );
  return `\n\n[context from turn ${t.id}: ${lines.join("; ")}]`;
}

export function memoryLine(t: Turn): string {
  const tools = t.tools.map((x) => `${x.name}(${argsBrief(x.args)})`).join(", ");
  const sources = t.citations
    .map((c) => c.label)
    .slice(0, 3)
    .join("; ");
  return [
    `- turn ${t.id} (${t.at.slice(0, 10)}, portfolio ${t.portfolioId ?? "none"}, ${t.status})`,
    `Q: ${clip(t.user, 140)}`,
    tools ? `tools: ${clip(tools, 160)}` : null,
    `A: ${clip(t.assistant, 220)}`,
    sources ? `sources: ${clip(sources, 120)}` : null,
  ]
    .filter(Boolean)
    .join(" | ");
}

export function assembleContext(
  conv: Conversation,
  selectedPortfolio: string | null,
): AssembledContext {
  const turns = conv.turns.filter((t) => t.status !== "failed" || t.assistant);
  const verbatim: Turn[] = [];
  let tokens = 0;
  for (let i = turns.length - 1; i >= 0 && verbatim.length < CONTEXT_LIMITS.verbatimTurns; i--) {
    const t = turns[i] as Turn;
    const cost = estimateTokens(t.user + t.assistant + toolNote(t));
    if (verbatim.length && tokens + cost > CONTEXT_LIMITS.verbatimTokens) break;
    verbatim.unshift(t);
    tokens += cost;
  }
  const older = turns.slice(0, turns.length - verbatim.length);
  const lines: string[] = [];
  let memTokens = 0;
  for (let i = older.length - 1; i >= 0; i--) {
    const line = memoryLine(older[i] as Turn);
    const cost = estimateTokens(line);
    if (memTokens + cost > CONTEXT_LIMITS.memoryTokens) break;
    lines.unshift(line);
    memTokens += cost;
  }
  const dropped = older.length - lines.length;
  const memory = lines.length
    ? `${dropped ? `${dropped} earlier turn(s) omitted; use conversation_recall with a turn id to read any turn in full.\n` : ""}${lines.join("\n")}`
    : null;
  const history: ChatMessage[] = verbatim.flatMap((t) => [
    { role: "user" as const, content: t.user },
    { role: "assistant" as const, content: `${t.assistant || "(no answer)"}${toolNote(t)}` },
  ]);
  const last = turns.at(-1);
  const portfolioChanged =
    last && last.portfolioId !== selectedPortfolio
      ? { from: last.portfolioId, to: selectedPortfolio }
      : null;
  return {
    history,
    memory,
    portfolioChanged,
    stats: {
      storedTurns: conv.turns.length,
      verbatim: verbatim.length,
      compacted: lines.length,
      dropped,
      tokens: tokens + memTokens,
    },
  };
}

export function appendTurn(conv: Conversation, turn: Turn): Conversation {
  const turns = [...conv.turns, turn].slice(-CONTEXT_LIMITS.storedTurns);
  return { ...conv, turns, portfolioId: turn.portfolioId, updatedAt: turn.at };
}

export function newConversation(
  id: string,
  portfolioId: string | null,
  now = new Date(),
): Conversation {
  const at = now.toISOString();
  return {
    version: CONVERSATION_VERSION,
    id,
    createdAt: at,
    updatedAt: at,
    portfolioId,
    turns: [],
  };
}
