import { isoDate } from "@ma/core";
import { LlmInvalidOutput } from "@ma/llm";
import {
  hasNewBrokerCall,
  type InsightOutcome,
  type IntelContext,
  shouldRegenerate,
  writeCurrentInsight,
} from "./context.js";
import { brokersHash } from "./hash.js";
import {
  assembleCompanyInputs,
  type BrokerView,
  type CompanyInputs,
  currentInsight,
  round,
} from "./inputs.js";
import { BROKER_DIGEST_SYSTEM, groundingFeedback, inputMessage } from "./prompts.js";
import { type BrokerDigest, brokerDigestSchema, INSIGHT_MODEL_VERSION } from "./schemas.js";
import { describeViolations, dropViolations, type Violation, validateClaims } from "./validate.js";

const DIGEST_ARRAYS = new Set(["byBroker"]);

export interface DigestComputed {
  targetDispersion: { low: number; high: number; mean: number; spreadPct: number } | null;
  revisionDirection: "up" | "down" | "flat";
  raised: number;
  cut: number;
}

export function latestPerBroker(brokers: readonly BrokerView[]): BrokerView[] {
  const seen = new Set<string>();
  return brokers.filter((b) => {
    const k = b.broker.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function computeDigest(
  inputs: Pick<CompanyInputs, "brokers" | "consensus">,
): DigestComputed {
  const latest = latestPerBroker(inputs.brokers);
  const targets = latest.map((b) => b.target).filter((t): t is number => t != null && t > 0);
  const c = inputs.consensus;
  let dispersion: DigestComputed["targetDispersion"] = null;
  if (targets.length >= 2) {
    const low = Math.min(...targets);
    const high = Math.max(...targets);
    const mean = targets.reduce((s, t) => s + t, 0) / targets.length;
    dispersion = {
      low,
      high,
      mean: round(mean, 2) as number,
      spreadPct: round(((high - low) / mean) * 100) as number,
    };
  } else if (c?.targetLow != null && c.targetHigh != null && c.targetMean) {
    dispersion = {
      low: c.targetLow,
      high: c.targetHigh,
      mean: c.targetMean,
      spreadPct: round(((c.targetHigh - c.targetLow) / c.targetMean) * 100) as number,
    };
  }
  const raised = latest.filter(
    (b) => b.target != null && b.priorTarget != null && b.target > b.priorTarget,
  ).length;
  const cut = latest.filter(
    (b) => b.target != null && b.priorTarget != null && b.target < b.priorTarget,
  ).length;
  const rev = c?.epsNextFyRevision30dPct ?? null;
  const score = raised - cut + (rev == null ? 0 : rev > 1 ? 1 : rev < -1 ? -1 : 0);
  return {
    targetDispersion: dispersion,
    revisionDirection: score > 0 ? "up" : score < 0 ? "down" : "flat",
    raised,
    cut,
  };
}

export function digestInputs(inputs: CompanyInputs) {
  const computed = computeDigest(inputs);
  const ids = new Set(inputs.brokers.map((b) => b.evidenceId));
  if (inputs.consensus) ids.add("cns");
  return {
    company: inputs.company,
    price: inputs.price ? { last: inputs.price.last, asOf: inputs.price.asOf } : null,
    consensus: inputs.consensus,
    brokers: latestPerBroker(inputs.brokers),
    computed,
    evidence: inputs.evidence
      .filter((e) => ids.has(e.id))
      .map(({ id, kind, label }) => ({ id, kind, label })),
  };
}

type DigestInput = ReturnType<typeof digestInputs>;

const digestKnown = (input: DigestInput) => new Set(input.evidence.map((e) => e.id));

export function finalizeDigest(raw: BrokerDigest, input: DigestInput): BrokerDigest {
  const byName = new Map(input.brokers.map((b) => [b.broker.toLowerCase(), b]));
  const known = digestKnown(input);
  const d = input.computed.targetDispersion;
  return {
    ...raw,
    byBroker: raw.byBroker.flatMap((b) => {
      const view = byName.get(b.broker.toLowerCase());
      return view ? [{ ...b, target: view.target, evidence: [view.evidenceId] }] : [];
    }),
    targetDispersion: {
      low: d?.low ?? 0,
      high: d?.high ?? 0,
      mean: d?.mean ?? 0,
      spreadPct: d?.spreadPct ?? 0,
      read: d ? raw.targetDispersion.read : "Not enough targets to measure dispersion.",
    },
    revisionMomentum: { ...raw.revisionMomentum, direction: input.computed.revisionDirection },
    evidence: [...new Set(raw.evidence)].filter((id) => known.has(id)),
  };
}

export const digestViolations = (digest: BrokerDigest, input: DigestInput): Violation[] =>
  validateClaims(digest, input, { known: digestKnown(input) });

export function groundDigest(
  digest: BrokerDigest,
  violations: readonly Violation[],
  input: DigestInput,
): BrokerDigest | null {
  if (!violations.length) return digest;
  const { output } = dropViolations(digest, violations, DIGEST_ARRAYS);
  if (!output.byBroker.length || digestViolations(output, input).length) return null;
  return output;
}

export async function generateBrokerDigest(
  ctx: IntelContext,
  companyId: number,
  opts: { asOf?: string; force?: boolean; inputs?: CompanyInputs } = {},
): Promise<InsightOutcome> {
  const inputs =
    opts.inputs ??
    (await assembleCompanyInputs(ctx.db, companyId, opts.asOf ?? isoDate(new Date())));
  if (!inputs.brokers.length) return "skipped";
  const hash = brokersHash(inputs);
  const current = await currentInsight(ctx.db, "broker_digest", companyId);
  const input = digestInputs(inputs);
  if (
    !shouldRegenerate(current, hash, INSIGHT_MODEL_VERSION, {
      force: opts.force ?? false,
      material: hasNewBrokerCall(current?.inputs ?? null, input.brokers),
    })
  )
    return "fresh";
  let promptTokens = 0;
  let completionTokens = 0;
  let model = ctx.llm.model;
  const ask = async (extra?: string) => {
    const res = await ctx.llm.complete({
      name: "broker_digest",
      system: BROKER_DIGEST_SYSTEM,
      user: inputMessage(input, extra),
      schema: brokerDigestSchema,
      maxOutputTokens: 3_000,
    });
    promptTokens += res.promptTokens;
    completionTokens += res.completionTokens;
    model = res.model;
    const digest = finalizeDigest(res.data, input);
    return { digest, violations: digestViolations(digest, input) };
  };
  let result = await ask();
  if (result.violations.length)
    result = await ask(groundingFeedback(describeViolations(result.violations)));
  const digest = groundDigest(result.digest, result.violations, input);
  if (!digest) throw new LlmInvalidOutput("broker_digest", "no grounded broker views");
  return writeCurrentInsight(ctx.db, {
    companyId,
    kind: "broker_digest",
    modelVersion: INSIGHT_MODEL_VERSION,
    model,
    inputHash: hash,
    inputs: input as unknown as Record<string, unknown>,
    output: digest as unknown as Record<string, unknown>,
    confidence: null,
    promptTokens,
    completionTokens,
  });
}
