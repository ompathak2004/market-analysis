import { sha256 } from "@ma/core";
import type { CompanyInputs } from "./inputs.js";

const VOLATILE_KEYS = new Set(["asOf", "generatedAt", "fetchedAt", "at", "last", "chg1dPct"]);

function normalize(value: unknown, key: string | null): unknown {
  if (Array.isArray(value)) return value.map((v) => normalize(v, null));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value).sort()) {
      if (VOLATILE_KEYS.has(k)) continue;
      const v = (value as Record<string, unknown>)[k];
      if (v === undefined) continue;
      out[k] = normalize(v, k);
    }
    return out;
  }
  if (typeof value === "number" && key && /pct$/i.test(key)) return Math.round(value * 10) / 10;
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value, null));
}

export function hashOf(value: unknown): string {
  return sha256(canonicalJson(value));
}

export function inputHash(inputs: CompanyInputs): string {
  const { asOf: _a, ruleInsights: _r, evidence: _e, previousBrief: _p, ...stable } = inputs;
  return hashOf(stable);
}

export function brokersHash(inputs: Pick<CompanyInputs, "brokers" | "consensus">): string {
  return hashOf({ brokers: inputs.brokers, consensus: inputs.consensus });
}
