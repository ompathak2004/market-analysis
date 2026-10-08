import { isoDate } from "@ma/core";
import { LlmInvalidOutput } from "@ma/llm";
import { type InsightOutcome, type IntelContext, isFresh, writeCurrentInsight } from "./context.js";
import { hashOf } from "./hash.js";
import { assembleMarketInputs, currentInsight, type MarketInputs } from "./inputs.js";
import { groundingFeedback, inputMessage, MARKET_BRIEF_SYSTEM } from "./prompts.js";
import { INSIGHT_MODEL_VERSION, type MarketBrief, marketBriefSchema } from "./schemas.js";
import {
  describeViolations,
  dropViolations,
  numbersGroundedInInputs,
  sanitizeEvidence,
  type Violation,
} from "./validate.js";

const MARKET_ARRAYS = new Set(["bullets", "notableCalls", "riskFlags"]);

export function hasMarketInputs(inputs: MarketInputs): boolean {
  return inputs.indices.length > 0 || (inputs.breadth?.sample ?? 0) > 0;
}

export function finalizeMarketBrief(
  raw: MarketBrief,
  inputs: MarketInputs,
): { brief: MarketBrief; violations: Violation[] } {
  const known = new Set(inputs.evidence.map((e) => e.id));
  const { output } = sanitizeEvidence(raw, known);
  return { brief: output, violations: numbersGroundedInInputs(output, inputs) };
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
  if (!opts.force && isFresh(current, hash, INSIGHT_MODEL_VERSION)) return "fresh";
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
  let brief = result.brief;
  if (result.violations.length) {
    const dropped = dropViolations(brief, result.violations, MARKET_ARRAYS).output;
    if (!marketBriefSchema.safeParse(dropped).success) {
      throw new LlmInvalidOutput("market_brief", "fewer than 3 grounded bullets");
    }
    brief = dropped;
  }
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
