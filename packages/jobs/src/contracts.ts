import { MINUTE } from "@ma/core";
import { z } from "zod";

export const LANES = ["control", "io", "parse", "compute", "llm", "cache"] as const;
export type Lane = (typeof LANES)[number];

export type JobKind = "fanout" | "unit";

const companyUnit = z.object({ companyId: z.number().int().positive() }).strict();
const empty = z.object({}).strict();
const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

interface Contract<S extends z.ZodTypeAny> {
  family: string | null;
  lane: Lane;
  kind: JobKind;
  schema: S;
  key: (payload: z.infer<S>) => string;
  deadlineMs: number;
  retryLimit: number;
}

const DEFAULT_RETRY_LIMIT = 4;

function job<S extends z.ZodTypeAny>(
  family: string | null,
  lane: Lane,
  kind: JobKind,
  schema: S,
  deadlineMs: number,
  key: (payload: z.infer<S>) => string = () => "",
  retryLimit = DEFAULT_RETRY_LIMIT,
): Contract<S> {
  return { family, lane, kind, schema, key, deadlineMs, retryLimit };
}

const byCompany = (p: { companyId: number }) => String(p.companyId);

export const JOB_CONTRACTS = {
  "universe.fanout": job("universe", "control", "fanout", empty, MINUTE),
  "universe.sync": job(
    "universe",
    "io",
    "unit",
    z.object({ index: z.string().min(1).max(40) }).strict(),
    4 * MINUTE,
    (p) => p.index,
  ),
  "prices.fanout": job("prices", "control", "fanout", empty, MINUTE),
  "prices.repair": job("prices", "control", "fanout", empty, MINUTE),
  "prices.sync": job(
    "prices",
    "io",
    "unit",
    z
      .object({ companyId: z.number().int().positive(), range: z.enum(["1mo", "1y"]).optional() })
      .strict(),
    2 * MINUTE,
    byCompany,
  ),
  "fundamentals.fanout": job("fundamentals", "control", "fanout", empty, MINUTE),
  "fundamentals.sync": job("fundamentals", "io", "unit", companyUnit, 3 * MINUTE, byCompany),
  "announcements.fanout": job("announcements", "control", "fanout", empty, MINUTE),
  "announcements.sync": job("announcements", "io", "unit", companyUnit, 3 * MINUTE, byCompany),
  "relationships.fanout": job("relationships", "control", "fanout", empty, MINUTE),
  "relationships.extract": job(
    "relationships",
    "parse",
    "unit",
    companyUnit,
    5 * MINUTE,
    byCompany,
  ),
  "intel.fanout": job("intel", "control", "fanout", empty, MINUTE),
  "intel.network": job(
    "intel",
    "compute",
    "unit",
    z.object({ asOf: isoDay }).strict(),
    5 * MINUTE,
    (p) => p.asOf,
  ),
  "intel.refresh": job(
    "intel",
    "compute",
    "unit",
    z.object({ companyId: z.number().int().positive(), asOf: isoDay }).strict(),
    MINUTE,
    byCompany,
  ),
  "research.fanout": job("moneycontrol", "control", "fanout", empty, MINUTE),
  "research.sync": job("moneycontrol", "io", "unit", companyUnit, 3 * MINUTE, byCompany),
  "broker.fetch": job("broker-reports", "io", "unit", empty, 5 * MINUTE),
  "broker.theses": job("broker-theses", "control", "fanout", empty, MINUTE),
  "broker.thesis": job(
    "broker-theses",
    "llm",
    "unit",
    z.object({ callId: z.number().int().positive() }).strict(),
    3 * MINUTE,
    (p) => String(p.callId),
  ),
  "insights.fanout": job("insights", "control", "fanout", empty, MINUTE),
  "insights.company": job("insights", "llm", "unit", companyUnit, 4 * MINUTE, byCompany),
  "insights.digest": job("insights", "llm", "unit", companyUnit, 4 * MINUTE, byCompany),
  "market-brief": job(
    "market-brief",
    "llm",
    "unit",
    z.object({ slot: z.enum(["open", "close", "manual"]) }).strict(),
    4 * MINUTE,
    (p) => p.slot,
  ),
  "triage.batch": job("triage", "llm", "unit", empty, 5 * MINUTE),
  "aircraft.registry": job("aircraft-registry", "io", "unit", empty, 5 * MINUTE),
  "aircraft.sample": job("aircraft-sample", "io", "unit", empty, MINUTE, () => "", 1),
  "ais.collect": job("ais-collect", "io", "unit", empty, 2 * MINUTE, () => "", 1),
  "altdata.derive": job("altdata-derive", "compute", "unit", empty, 5 * MINUTE),
  "altdata.signals": job("altdata-signals", "compute", "unit", empty, 5 * MINUTE),
  fleets: job("fleets", "io", "unit", empty, 5 * MINUTE),
  "altdata.cleanup": job("altdata-cleanup", "compute", "unit", empty, 3 * MINUTE),
  "ops.reconcile": job(null, "control", "unit", empty, MINUTE, () => "", 1),
  "cache.invalidate": job(
    null,
    "cache",
    "unit",
    z.object({ family: z.string().min(1).max(40) }).strict(),
    MINUTE,
    (p) => p.family,
  ),
  "maintenance.prune": job(null, "compute", "unit", empty, 5 * MINUTE),
  "ops.digest": job(null, "control", "unit", empty, MINUTE),
} as const;

export type JobType = keyof typeof JOB_CONTRACTS;
export type JobPayload<T extends JobType> = z.infer<(typeof JOB_CONTRACTS)[T]["schema"]>;

export const JOB_TYPES = Object.keys(JOB_CONTRACTS) as JobType[];

export function isJobType(value: string): value is JobType {
  return Object.hasOwn(JOB_CONTRACTS, value);
}

export function contractOf(type: JobType) {
  return JOB_CONTRACTS[type] as unknown as Contract<z.ZodTypeAny>;
}

export function parsePayload<T extends JobType>(type: T, payload: unknown): JobPayload<T> {
  return contractOf(type).schema.parse(payload ?? {}) as JobPayload<T>;
}

export function unitKey<T extends JobType>(type: T, payload: JobPayload<T>): string {
  const suffix = contractOf(type).key(payload);
  return suffix ? `${type}:${suffix}` : type;
}

export function laneOf(type: JobType): Lane {
  return contractOf(type).lane;
}

export function familyOf(type: JobType): string | null {
  return contractOf(type).family;
}

export interface JobEnvelope {
  type: JobType;
  payload: Record<string, unknown>;
  campaignId: number | null;
  runId: number | null;
  attemptBase: number;
  deferrals: number;
}

const envelopeSchema = z
  .object({
    type: z.string(),
    payload: z.record(z.unknown()).default({}),
    campaignId: z.number().int().positive().nullable().default(null),
    runId: z.number().int().positive().nullable().default(null),
    attemptBase: z.number().int().min(0).default(0),
    deferrals: z.number().int().min(0).default(0),
  })
  .strict();

export function parseEnvelope(data: unknown): JobEnvelope {
  const env = envelopeSchema.parse(data);
  if (!isJobType(env.type))
    throw new z.ZodError([
      { code: "custom", path: ["type"], message: `unknown job type ${env.type}` },
    ]);
  parsePayload(env.type, env.payload);
  return { ...env, type: env.type };
}
