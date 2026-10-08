import { isoDate } from "@ma/core";
import { type JsonResult, LlmInvalidOutput } from "@ma/llm";
import {
  hasNewBrokerCall,
  hasNewMaterialAnnouncement,
  type InsightOutcome,
  type IntelContext,
  shouldRegenerate,
  writeCurrentInsight,
} from "./context.js";
import { inputHash } from "./hash.js";
import { assembleCompanyInputs, type CompanyInputs, currentInsight } from "./inputs.js";
import { COMPANY_BRIEF_SYSTEM, groundingFeedback, inputMessage } from "./prompts.js";
import {
  type CompanyBrief,
  companyBriefSchema,
  INSIGHT_MODEL_VERSION,
  verdictLabelFor,
} from "./schemas.js";
import {
  describeViolations,
  dropViolations,
  numbersGroundedInInputs,
  sanitizeEvidence,
  type Violation,
} from "./validate.js";

const BRIEF_ARRAYS = new Set(["thesis", "risks", "catalysts", "whatChanged", "uncertainty"]);
const MIN_THESIS = 3;

export function modelView(inputs: CompanyInputs) {
  return {
    ...inputs,
    evidence: inputs.evidence.map(({ id, kind, label }) => ({ id, kind, label })),
  };
}

const nullIfBlank = (v: string | null) => (v?.trim() ? v : null);

export function finalizeBrief(
  raw: CompanyBrief,
  inputs: CompanyInputs,
): { brief: CompanyBrief; violations: Violation[]; removedEvidence: string[] } {
  const known = new Set(inputs.evidence.map((e) => e.id));
  const { output, removed } = sanitizeEvidence(raw, known);
  const score = Math.round(Math.max(0, Math.min(100, output.verdict.score)));
  const brief: CompanyBrief = {
    ...output,
    verdict: {
      ...output.verdict,
      score,
      label: verdictLabelFor(score),
      confidence: Math.round(Math.max(0, Math.min(1, output.verdict.confidence)) * 100) / 100,
    },
    whatChanged: inputs.previousBrief ? output.whatChanged : [],
    managementTravel: { read: inputs.travel ? nullIfBlank(output.managementTravel.read) : null },
    logistics: { read: inputs.logistics ? nullIfBlank(output.logistics.read) : null },
    supplyChain: { read: nullIfBlank(output.supplyChain.read) },
  };
  return { brief, violations: numbersGroundedInInputs(brief, inputs), removedEvidence: removed };
}

export function applyViolations(
  brief: CompanyBrief,
  violations: readonly Violation[],
): CompanyBrief | null {
  if (!violations.length) return brief;
  const { output, dropped } = dropViolations(brief, violations, BRIEF_ARRAYS);
  if (output.thesis.length < MIN_THESIS) return null;
  const cleaned: CompanyBrief = {
    ...output,
    whatChanged: output.whatChanged.filter((s) => s.trim()),
    uncertainty: [
      ...output.uncertainty.filter((s) => s.trim()),
      `${dropped} statement${dropped === 1 ? "" : "s"} removed because the figures could not be traced to inputs.`,
    ],
    verdict: {
      ...output.verdict,
      oneLiner: output.verdict.oneLiner.trim() || (brief.thesis[0]?.point ?? "").slice(0, 240),
      confidence: Math.max(0, Math.round((output.verdict.confidence - 0.1) * 100) / 100),
    },
    valuation: {
      read: output.valuation.read.trim() || "Valuation read not available.",
      vsPeers: nullIfBlank(output.valuation.vsPeers),
      vsConsensus: nullIfBlank(output.valuation.vsConsensus),
    },
    supplyChain: { read: nullIfBlank(output.supplyChain.read) },
    managementTravel: { read: nullIfBlank(output.managementTravel.read) },
    logistics: { read: nullIfBlank(output.logistics.read) },
  };
  return companyBriefSchema.safeParse(cleaned).success ? cleaned : null;
}

export function hasBriefInputs(inputs: CompanyInputs): boolean {
  return inputs.price != null || inputs.fundamentals != null;
}

export async function generateCompanyBrief(
  ctx: IntelContext,
  companyId: number,
  opts: { asOf?: string; force?: boolean; inputs?: CompanyInputs } = {},
): Promise<InsightOutcome> {
  const inputs =
    opts.inputs ??
    (await assembleCompanyInputs(ctx.db, companyId, opts.asOf ?? isoDate(new Date())));
  if (!hasBriefInputs(inputs)) return "skipped";
  const hash = inputHash(inputs);
  const current = await currentInsight(ctx.db, "company_brief", companyId);
  const material =
    hasNewBrokerCall(current?.inputs ?? null, inputs.brokers) ||
    hasNewMaterialAnnouncement(current?.inputs ?? null, inputs.announcements);
  if (
    !shouldRegenerate(current, hash, INSIGHT_MODEL_VERSION, {
      force: opts.force ?? false,
      material,
    })
  )
    return "fresh";
  const view = modelView(inputs);
  const log = ctx.logger.child({ product: "company_brief", symbol: inputs.company.symbol });
  const calls: JsonResult<CompanyBrief>[] = [];
  const ask = async (extra?: string) => {
    const res = await ctx.llm.complete({
      name: "company_brief",
      system: COMPANY_BRIEF_SYSTEM,
      user: inputMessage(view, extra),
      schema: companyBriefSchema,
      maxOutputTokens: 4_000,
    });
    calls.push(res);
    return finalizeBrief(res.data, inputs);
  };
  let result = await ask();
  if (result.violations.length) {
    log.info({ violations: result.violations.length }, "brief numbers not grounded, retrying");
    result = await ask(groundingFeedback(describeViolations(result.violations)));
  }
  const brief = applyViolations(result.brief, result.violations);
  if (!brief) {
    log.warn({ violations: result.violations.length }, "brief rejected after grounding");
    throw new LlmInvalidOutput("company_brief", "fewer than 3 grounded thesis points");
  }
  const last = calls.at(-1) as JsonResult<CompanyBrief>;
  return writeCurrentInsight(ctx.db, {
    companyId,
    kind: "company_brief",
    modelVersion: INSIGHT_MODEL_VERSION,
    model: last.model,
    inputHash: hash,
    inputs: inputs as unknown as Record<string, unknown>,
    output: brief as unknown as Record<string, unknown>,
    confidence: brief.verdict.confidence,
    promptTokens: calls.reduce((s, c) => s + c.promptTokens, 0),
    completionTokens: calls.reduce((s, c) => s + c.completionTokens, 0),
  });
}
