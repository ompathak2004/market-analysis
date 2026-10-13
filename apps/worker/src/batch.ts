import { throwIfAborted } from "@ma/core";
import { markFailed, markSynced } from "@ma/jobs";
import type { UnitRun } from "./registry.js";

export type Metrics = Record<string, number>;

export function numericMetrics(value: unknown, prefix = ""): Metrics {
  const out: Metrics = {};
  if (value == null || typeof value !== "object") return out;
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === "number" && Number.isFinite(v)) out[`${prefix}${k}`] = v;
    else if (typeof v === "boolean") out[`${prefix}${k}`] = v ? 1 : 0;
  }
  return out;
}

export async function trackCompany<T>(
  run: Pick<UnitRun, "ctx" | "signal" | "fence">,
  job: string,
  companyId: number,
  fn: () => Promise<T>,
): Promise<T> {
  const { ctx, signal, fence } = run;
  try {
    const result = await fn();
    throwIfAborted(signal);
    await markSynced(ctx.db, job, companyId, fence);
    return result;
  } catch (err) {
    if (!signal.aborted) await markFailed(ctx.db, job, companyId, err).catch(() => undefined);
    throw err;
  }
}
