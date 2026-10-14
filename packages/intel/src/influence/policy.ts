import { POLICY_SECTORS, sectorsForMinistry } from "@ma/ingest";
import type { LlmClient } from "@ma/llm";
import { z } from "zod";
import { CONFIDENCE } from "./resolve.js";
import type { SourceKind } from "./types.js";

export const POLICY_TAGGER_VERSION = 1;
export const POLICY_LLM_TEXT_CHARS = 6_000;
export const POLICY_QUOTE_MIN_CHARS = 20;
export const POLICY_QUOTE_MAX_CHARS = 400;
const NAME_MIN_CHARS = 6;

export interface PolicyText {
  title: string;
  ministry: string | null;
  text: string;
}

export interface PolicyCompany {
  id: number;
  normalizedName: string;
}

export type PolicyTagTarget = { sectorKey: string } | { companyId: number };

export interface PolicyTagClaim {
  target: PolicyTagTarget;
  basis: "rule" | "llm";
  confidence: number;
  source: SourceKind;
  identifier: boolean;
  field: "ministry" | "title" | "text";
  quote: string;
}

export const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function companyNamePattern(normalizedName: string): RegExp | null {
  const words = normalizedName.split(" ").filter(Boolean);
  if (!words.length) return null;
  if (words.length === 1 && (words[0] ?? "").length < NAME_MIN_CHARS) return null;
  return new RegExp(
    `(?<![\\p{L}\\p{N}])${words.map(escapeRegex).join("[\\s-]+")}(?![\\p{L}\\p{N}])`,
    "iu",
  );
}

export function ruleTags(doc: PolicyText, companies: readonly PolicyCompany[]): PolicyTagClaim[] {
  const out: PolicyTagClaim[] = sectorsForMinistry(doc.ministry).map((sectorKey) => ({
    target: { sectorKey },
    basis: "rule",
    confidence: CONFIDENCE.twoPrimaryDocuments,
    source: "structured_primary",
    identifier: true,
    field: "ministry",
    quote: doc.ministry ?? "",
  }));
  for (const c of companies) {
    const re = companyNamePattern(c.normalizedName);
    if (!re) continue;
    for (const field of ["title", "text"] as const) {
      const hit = re.exec(doc[field]);
      if (!hit) continue;
      out.push({
        target: { companyId: c.id },
        basis: "rule",
        confidence: CONFIDENCE.singleDocumentName,
        source: "primary",
        identifier: false,
        field,
        quote: hit[0],
      });
      break;
    }
  }
  return out;
}

export const policyLlmSchema = z.object({
  tags: z
    .array(
      z.object({
        sector: z.string(),
        quote: z.string(),
      }),
    )
    .max(5),
});

export type PolicyLlmOutput = z.infer<typeof policyLlmSchema>;

export const POLICY_LLM_SYSTEM = [
  "You tag Indian government policy releases to the economic sectors they directly apply to.",
  "Use only the policy text you are given. Tag a sector only when the text itself states a concrete measure for that sector (a rule, tariff, duty, subsidy, licence, allocation, ban, approval or scheme).",
  "For each tag copy one sentence from the text verbatim as quote; it must state the measure and name the sector or its products.",
  "Do not infer second-order effects. Return an empty list when no sector is directly addressed.",
  `Allowed sector keys: ${POLICY_SECTORS.map((s) => `${s.key} (${s.label})`).join("; ")}.`,
].join("\n");

export function policyLlmUser(doc: PolicyText): string {
  return JSON.stringify({
    title: doc.title,
    ministry: doc.ministry,
    text: doc.text.slice(0, POLICY_LLM_TEXT_CHARS),
  });
}

export function acceptLlmTags(
  doc: PolicyText,
  output: PolicyLlmOutput,
  already: ReadonlySet<string>,
): PolicyTagClaim[] {
  const allowed = new Set(POLICY_SECTORS.map((s) => s.key));
  const seen = new Set(already);
  const out: PolicyTagClaim[] = [];
  for (const t of output.tags) {
    const quote = t.quote.replace(/\s+/g, " ").trim();
    if (!allowed.has(t.sector) || seen.has(t.sector)) continue;
    if (quote.length < POLICY_QUOTE_MIN_CHARS || quote.length > POLICY_QUOTE_MAX_CHARS) continue;
    const field = doc.text.replace(/\s+/g, " ").includes(quote)
      ? "text"
      : doc.title.includes(quote)
        ? "title"
        : null;
    if (!field) continue;
    seen.add(t.sector);
    out.push({
      target: { sectorKey: t.sector },
      basis: "llm",
      confidence: CONFIDENCE.newsOrInference,
      source: "inference",
      identifier: false,
      field,
      quote,
    });
  }
  return out;
}

export async function llmTags(
  llm: Pick<LlmClient, "complete">,
  doc: PolicyText,
  already: ReadonlySet<string>,
): Promise<{ tags: PolicyTagClaim[]; tokens: number }> {
  const res = await llm.complete({
    name: "influence_policy_tag",
    system: POLICY_LLM_SYSTEM,
    user: policyLlmUser(doc),
    schema: policyLlmSchema,
    maxOutputTokens: 600,
    temperature: 0,
    budgetClass: "influence",
  });
  return {
    tags: acceptLlmTags(doc, res.data, already),
    tokens: res.promptTokens + res.completionTokens,
  };
}

export const tagTargetKey = (t: PolicyTagTarget) =>
  "sectorKey" in t ? `sector:${t.sectorKey}` : `company:${t.companyId}`;
