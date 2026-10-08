import { isoDate } from "@ma/core";
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
import { BROKER_DIGEST_SYSTEM, inputMessage } from "./prompts.js";
import { type BrokerDigest, brokerDigestSchema, INSIGHT_MODEL_VERSION } from "./schemas.js";

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

export function finalizeDigest(
  raw: BrokerDigest,
  input: ReturnType<typeof digestInputs>,
): BrokerDigest {
  const byName = new Map(input.brokers.map((b) => [b.broker.toLowerCase(), b]));
  const d = input.computed.targetDispersion;
  return {
    ...raw,
    byBroker: raw.byBroker
      .filter((b) => byName.has(b.broker.toLowerCase()))
      .map((b) => ({ ...b, target: byName.get(b.broker.toLowerCase())?.target ?? null })),
    targetDispersion: {
      low: d?.low ?? 0,
      high: d?.high ?? 0,
      mean: d?.mean ?? 0,
      spreadPct: d?.spreadPct ?? 0,
      read: d ? raw.targetDispersion.read : "Not enough targets to measure dispersion.",
    },
    revisionMomentum: { ...raw.revisionMomentum, direction: input.computed.revisionDirection },
  };
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
  const res = await ctx.llm.complete({
    name: "broker_digest",
    system: BROKER_DIGEST_SYSTEM,
    user: inputMessage(input),
    schema: brokerDigestSchema,
    maxOutputTokens: 3_000,
  });
  const digest = finalizeDigest(res.data, input);
  return writeCurrentInsight(ctx.db, {
    companyId,
    kind: "broker_digest",
    modelVersion: INSIGHT_MODEL_VERSION,
    model: res.model,
    inputHash: hash,
    inputs: input as unknown as Record<string, unknown>,
    output: digest as unknown as Record<string, unknown>,
    confidence: null,
    promptTokens: res.promptTokens,
    completionTokens: res.completionTokens,
  });
}
