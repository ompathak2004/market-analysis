import type { Db } from "@ma/db";
import { markFailed, markSynced } from "@ma/jobs";

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
  db: Db,
  job: string,
  companyId: number,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    const result = await fn();
    await markSynced(db, job, companyId);
    return result;
  } catch (err) {
    await markFailed(db, job, companyId, err).catch(() => undefined);
    throw err;
  }
}
