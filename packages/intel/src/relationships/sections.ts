import { estimateTokens } from "@ma/llm";

export type Cue = readonly [pattern: RegExp, weight: number];

export interface Section {
  evidenceId: string;
  start: number;
  end: number;
  text: string;
  score: number;
}

export interface SectionOptions {
  budgetTokens: number;
  chunkChars?: number;
  minScore?: number;
  extraScore?: (slice: string, start: number) => number;
}

export const SECTION_CHARS = 1_800;
const MIN_SCORE = 3;
const SECTION_OVERHEAD_TOKENS = 12;

export const RELATIONSHIP_CUES: readonly Cue[] = [
  [/\bcustomers?\b/gi, 1],
  [/\bclients?\b/gi, 1],
  [/\bsuppliers?\b/gi, 1],
  [/\bvendors?\b/gi, 1],
  [/\bOEMs?\b/g, 1],
  [/\bofftake(?:rs?)?\b/gi, 1],
  [/\b(?:orders?|contracts?)\b/gi, 1],
  [/\bsuppl(?:y|ies|ied|ying) to\b/gi, 2],
  [/\b(?:sourced?|sourcing|procured?|purchases?) from\b/gi, 2],
  [/\bsales to\b/gi, 2],
  [/\brelated part(?:y|ies)\b/gi, 1],
  [
    /\b(?:single|major|largest|biggest|top|key|anchor|marquee)\s+(?:\w+\s+){0,2}(?:customers?|clients?)\b/gi,
    3,
  ],
  [
    /\d(?:\.\d+)?\s*(?:%|per ?cent)\s+of\s+(?:\w+\s+){0,3}(?:revenue|sales|turnover|income|purchases)\b/gi,
    3,
  ],
];

export function chunkText(
  text: string,
  size = SECTION_CHARS,
): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  let pos = 0;
  while (pos < text.length) {
    while (pos < text.length && /\s/.test(text[pos] as string)) pos++;
    if (pos >= text.length) break;
    let end = Math.min(text.length, pos + size);
    if (end < text.length) end = breakAt(text, pos + Math.floor(size / 2), end);
    out.push({ start: pos, end });
    pos = end;
  }
  return out;
}

function breakAt(text: string, from: number, to: number): number {
  const window = text.slice(from, to);
  const paragraph = window.lastIndexOf("\n\n");
  if (paragraph >= 0) return from + paragraph + 2;
  const sentence = Math.max(window.lastIndexOf(". "), window.lastIndexOf(".\n"));
  if (sentence >= 0) return from + sentence + 2;
  const space = window.search(/\s\S*$/);
  return space > 0 ? from + space + 1 : to;
}

export function cueScore(slice: string, cues: readonly Cue[]): number {
  let score = 0;
  for (const [pattern, weight] of cues) score += (slice.match(pattern)?.length ?? 0) * weight;
  return score;
}

export function selectSections(
  text: string,
  cues: readonly Cue[],
  opts: SectionOptions,
): Section[] {
  const minScore = opts.minScore ?? MIN_SCORE;
  const scored = chunkText(text, opts.chunkChars ?? SECTION_CHARS).flatMap(({ start, end }) => {
    const slice = text.slice(start, end);
    const base = cueScore(slice, cues);
    if (base === 0) return [];
    const score = base + (opts.extraScore?.(slice, start) ?? 0);
    if (score < minScore) return [];
    return [{ start, end, text: slice.replace(/\s+/g, " ").trim(), score }];
  });
  const picked: typeof scored = [];
  let used = 0;
  for (const s of [...scored].sort((a, b) => b.score - a.score || a.start - b.start)) {
    const cost = estimateTokens(s.text) + SECTION_OVERHEAD_TOKENS;
    if (used + cost > opts.budgetTokens) continue;
    picked.push(s);
    used += cost;
  }
  return picked
    .sort((a, b) => a.start - b.start)
    .map((s, i) => ({ evidenceId: `S${i + 1}`, ...s }));
}
