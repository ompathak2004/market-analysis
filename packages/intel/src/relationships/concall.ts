import { fiscalYearFromLabel, LLM_EXTRACTOR_VERSION_BASE, periodEndFromLabel } from "@ma/ingest";
import { type LlmSource, pendingLlmDocuments } from "./extract.js";
import { CONCALL_SYSTEM } from "./prompts.js";
import { type Cue, RELATIONSHIP_CUES } from "./sections.js";

export const CONCALL_LLM_EXTRACTOR_VERSION = LLM_EXTRACTOR_VERSION_BASE + 1;

const CONCALL_CUES: readonly Cue[] = [
  ...RELATIONSHIP_CUES,
  [/\b(?:new|repeat|existing) (?:customers?|clients?|orders?)\b/gi, 2],
  [/\b(?:share of (?:business|wallet)|wallet share)\b/gi, 2],
];

const NAME = "[A-Z][A-Za-z.'’]+(?: [A-Z][A-Za-z.'’]+){0,3}";
const ANALYST_INTRO = new RegExp(
  `question(?:s)? (?:is |comes )?from (?:the line of )?(?:(?:Mr|Ms|Mrs|Dr)\\.? )?(${NAME})`,
  "g",
);
const TURN = new RegExp(`^[ \\t]*(${NAME})\\s*:`, "gm");

function speakerKey(name: string): string {
  return name
    .replace(/^(?:Mr|Ms|Mrs|Dr)\.?\s+/, "")
    .trim()
    .toLowerCase();
}

export function maskAnalystTurns(text: string): string {
  const analysts = new Set(["moderator"]);
  for (const m of text.matchAll(ANALYST_INTRO)) analysts.add(speakerKey(m[1] as string));
  const turns = [...text.matchAll(TURN)].map((m) => ({
    at: m.index,
    speaker: speakerKey(m[1] as string),
  }));
  if (!turns.length) return text;
  let out = "";
  let pos = 0;
  for (const [i, turn] of turns.entries()) {
    const end = turns[i + 1]?.at ?? text.length;
    if (!analysts.has(turn.speaker)) continue;
    out += text.slice(pos, turn.at) + text.slice(turn.at, end).replace(/[^\n]/g, " ");
    pos = end;
  }
  return out + text.slice(pos);
}

export const CONCALL_LLM_SOURCE: LlmSource = {
  name: "concall",
  extractorVersion: CONCALL_LLM_EXTRACTOR_VERSION,
  system: CONCALL_SYSTEM,
  cues: CONCALL_CUES,
  sectionTokens: 6_000,
  maxOutputTokens: 1_200,
  maxConfidence: 0.8,
  minScore: 4,
  thirdParty: false,
  roles: ["customer", "supplier"],
  markRead: false,
  families: ["concall"],
  prepare: maskAnalystTurns,
  pending: (db, scope) =>
    pendingLlmDocuments(db, scope, {
      families: ["concall"],
      extractorVersion: CONCALL_LLM_EXTRACTOR_VERSION,
    }),
  period: (doc) => {
    const end =
      doc.label && fiscalYearFromLabel(doc.label) !== null
        ? periodEndFromLabel(doc.label)
        : (doc.publishedAt?.slice(0, 10) ?? null);
    return { start: null, end, fiscalYear: null };
  },
};
