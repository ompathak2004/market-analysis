import { isoDate } from "@ma/core";
import { LlmInvalidOutput } from "@ma/llm";
import {
  type InsightOutcome,
  type IntelContext,
  shouldRegenerate,
  writeCurrentInsight,
} from "./context.js";
import { hashOf } from "./hash.js";
import { assembleMarketInputs, currentInsight, type MarketInputs } from "./inputs.js";
import { groundingFeedback, inputMessage, MARKET_BRIEF_SYSTEM } from "./prompts.js";
import { INSIGHT_MODEL_VERSION, type MarketBrief, marketBriefSchema } from "./schemas.js";
import {
  describeViolations,
  dropViolations,
  sanitizeEvidence,
  type Violation,
  validateClaims,
} from "./validate.js";

const MARKET_ARRAYS = new Set(["bullets", "notableCalls", "riskFlags"]);
const MARKET_COOLDOWN_MS = 6 * 3_600_000;

export function hasMarketInputs(inputs: MarketInputs): boolean {
  return inputs.indices.length > 0 || (inputs.breadth?.sample ?? 0) > 0;
}

const marketSections = (inputs: MarketInputs): Record<string, unknown> => ({
  brd: inputs.breadth,
  sec: inputs.sectors,
  ...Object.fromEntries(inputs.indices.map((i) => [`idx:${i.code}`, i])),
});

const marketViolations = (brief: MarketBrief, inputs: MarketInputs): Violation[] =>
  validateClaims(brief, inputs, {
    known: new Set(inputs.evidence.map((e) => e.id)),
    sections: marketSections(inputs),
  });

export function finalizeMarketBrief(
  raw: MarketBrief,
  inputs: MarketInputs,
): { brief: MarketBrief; violations: Violation[] } {
  const { output } = sanitizeEvidence(raw, new Set(inputs.evidence.map((e) => e.id)));
  return { brief: output, violations: marketViolations(output, inputs) };
}

export function groundMarketBrief(
  brief: MarketBrief,
  violations: readonly Violation[],
  inputs: MarketInputs,
): MarketBrief | null {
  if (!violations.length) return brief;
  const { output } = dropViolations(brief, violations, MARKET_ARRAYS);
  if (!marketBriefSchema.safeParse(output).success) return null;
  return marketViolations(output, inputs).length ? null : output;
}

export async function generateMarketBrief(
  ctx: IntelContext,
  opts: { asOf?: string; force?: boolean } = {},
): Promise<InsightOutcome> {
  const asOf = opts.asOf ?? isoDate(new Date());
  const inputs = await assembleMarketInputs(ctx.db, asOf);
  if (!hasMarketInputs(inputs)) return "skipped";
  const { asOf: _a, ...stable } = inputs;
  const hash = hashOf(stable);
  const current = await currentInsight(ctx.db, "market_brief", null);
  if (
    !shouldRegenerate(current, hash, INSIGHT_MODEL_VERSION, {
      force: opts.force ?? false,
      material: false,
      cooldownMs: MARKET_COOLDOWN_MS,
    })
  )
    return "fresh";
  const view = {
    ...inputs,
    evidence: inputs.evidence.map(({ id, kind, label }) => ({ id, kind, label })),
  };
  let promptTokens = 0;
  let completionTokens = 0;
  let model = ctx.llm.model;
  const ask = async (extra?: string) => {
    const res = await ctx.llm.complete({
      name: "market_brief",
      system: MARKET_BRIEF_SYSTEM,
      user: inputMessage(view, extra),
      schema: marketBriefSchema,
      maxOutputTokens: 3_000,
    });
    promptTokens += res.promptTokens;
    completionTokens += res.completionTokens;
    model = res.model;
    return finalizeMarketBrief(res.data, inputs);
  };
  let result = await ask();
  if (result.violations.length)
    result = await ask(groundingFeedback(describeViolations(result.violations)));
  const brief = groundMarketBrief(result.brief, result.violations, inputs);
  if (!brief) throw new LlmInvalidOutput("market_brief", "fewer than 3 grounded bullets");
  return writeCurrentInsight(ctx.db, {
    companyId: null,
    kind: "market_brief",
    modelVersion: INSIGHT_MODEL_VERSION,
    model,
    inputHash: hash,
    inputs: inputs as unknown as Record<string, unknown>,
    output: brief as unknown as Record<string, unknown>,
    confidence: null,
    promptTokens,
    completionTokens,
  });
}
