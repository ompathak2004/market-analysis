import { MINUTE, sha256 } from "@ma/core";
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

const httpsUrl = z.string().url().startsWith("https://").max(500);
const BOND_URLS_MAX = 20;
const GAZETTE_URLS_MAX = 50;

const priceSymbol = z.string().min(1).max(40);
const priceWindow = z
  .object({
    seriesId: z.number().int().positive(),
    symbol: priceSymbol,
    from: isoDay,
    toExclusive: isoDay,
    generation: z.number().int().nonnegative(),
    parserVersion: z.number().int().positive(),
    mode: z.enum(["backfill", "repair"]).optional(),
  })
  .strict()
  .refine((p) => p.from < p.toExclusive, "empty window");
const dailyPrice = z
  .object({ seriesId: z.number().int().positive(), symbol: priceSymbol, date: isoDay })
  .strict();
const byDay = (p: { symbol: string; date: string }) => `${p.symbol}:${p.date}`;

const announcementStep = z.object({ day: isoDay, maxId: z.number().int().nonnegative() }).strict();
const backedUpStep = announcementStep.extend({ backupKey: z.string().min(1).max(200) }).strict();
const byStep = (p: { day: string; maxId: number }) => `${p.day}:${p.maxId}`;

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
  "prices.fanout": job("prices", "control", "fanout", empty, 2 * MINUTE),
  "prices.repair": job("prices", "control", "fanout", empty, 5 * MINUTE),
  "prices.backfill": job("prices", "control", "fanout", empty, 3 * MINUTE),
  "prices.window": job(
    "prices",
    "io",
    "unit",
    priceWindow,
    3 * MINUTE,
    (p) =>
      `${p.mode === "repair" ? "repair:" : ""}${p.symbol}:${p.from}:${p.toExclusive}:g${p.generation}:p${p.parserVersion}`,
  ),
  "prices.daily": job("prices", "io", "unit", dailyPrice, 2 * MINUTE, byDay),
  "index.daily": job("prices", "io", "unit", dailyPrice, 2 * MINUTE, byDay),
  "prices.rebuild": job(
    "prices",
    "io",
    "unit",
    z
      .object({
        seriesId: z.number().int().positive(),
        symbol: priceSymbol,
        generation: z.number().int().positive(),
        parserVersion: z.number().int().positive(),
      })
      .strict(),
    5 * MINUTE,
    (p) => `${p.symbol}:g${p.generation}:p${p.parserVersion}`,
  ),
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
    z.object({ companyId: z.number().int().positive(), force: z.boolean().optional() }).strict(),
    5 * MINUTE,
    (p) => (p.force ? `${p.companyId}:force` : String(p.companyId)),
  ),
  "relationships.counterparties": job("relationships", "compute", "unit", empty, 5 * MINUTE),
  "relationships.rebuild": job("relationships", "control", "fanout", empty, MINUTE, () => "", 1),
  "orders.fanout": job("relationships", "control", "fanout", empty, MINUTE),
  "orders.extract": job("relationships", "io", "unit", companyUnit, 5 * MINUTE, byCompany),
  "relationships.llm": job("relationships", "control", "fanout", empty, 2 * MINUTE),
  "relationships.llm.extract": job(
    "relationships",
    "llm",
    "unit",
    z
      .object({
        companyId: z.number().int().positive(),
        documentId: z.number().int().positive(),
        revisionId: z.number().int().positive(),
        source: z.string().min(1).max(40),
      })
      .strict(),
    4 * MINUTE,
    (p) => `${p.source}:${p.documentId}:${p.revisionId}`,
  ),
  "relationships.priors": job("intel", "compute", "unit", empty, 5 * MINUTE),
  "ratings.fanout": job("relationships", "control", "fanout", empty, MINUTE),
  "ratings.sync": job("relationships", "io", "unit", companyUnit, 4 * MINUTE, byCompany),
  "presentations.fanout": job("relationships", "control", "fanout", empty, MINUTE),
  "presentations.sync": job("relationships", "io", "unit", companyUnit, 3 * MINUTE, byCompany),
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
  "influence.governance.fanout": job("influence", "control", "fanout", empty, MINUTE),
  "influence.governance": job("influence", "io", "unit", companyUnit, 3 * MINUTE, byCompany),
  "influence.rpt.fanout": job("influence", "control", "fanout", empty, MINUTE),
  "influence.rpt": job("influence", "io", "unit", companyUnit, 3 * MINUTE, byCompany),
  "influence.perimeter.fanout": job("influence", "control", "fanout", empty, MINUTE),
  "influence.perimeter": job("influence", "compute", "unit", companyUnit, 2 * MINUTE, byCompany),
  "influence.parliament": job("influence", "io", "unit", empty, 10 * MINUTE),
  "influence.affidavits": job("influence", "io", "fanout", empty, 5 * MINUTE),
  "influence.affidavit": job(
    "influence",
    "io",
    "unit",
    z
      .object({
        personId: z.number().int().positive(),
        candidate: z.string().regex(/^[A-Za-z0-9]+:\d+$/),
      })
      .strict(),
    2 * MINUTE,
    (p) => `${p.personId}:${p.candidate}`,
  ),
  "influence.bonds": job(
    "influence",
    "io",
    "unit",
    z
      .object({
        purchaseUrls: z.array(httpsUrl).min(1).max(BOND_URLS_MAX),
        redemptionUrls: z.array(httpsUrl).min(1).max(BOND_URLS_MAX),
      })
      .strict(),
    45 * MINUTE,
    (p) => sha256(JSON.stringify([p.purchaseUrls, p.redemptionUrls])).slice(0, 32),
    1,
  ),
  "influence.policy.pib": job("influence", "io", "unit", empty, 10 * MINUTE),
  "influence.policy.gazette": job(
    "influence",
    "io",
    "unit",
    z.object({ urls: z.array(httpsUrl).max(GAZETTE_URLS_MAX).optional() }).strict(),
    15 * MINUTE,
  ),
  "influence.policy.prs": job("influence", "io", "unit", empty, 10 * MINUTE),
  "influence.sectors": job("influence", "compute", "unit", empty, 20 * MINUTE),
  "influence.policy.tag": job("influence", "control", "fanout", empty, 3 * MINUTE),
  "influence.policy.tag.event": job(
    "influence",
    "llm",
    "unit",
    z.object({ policyEventId: z.number().int().positive() }).strict(),
    2 * MINUTE,
    (p) => String(p.policyEventId),
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
  "maintenance.prune": job(null, "compute", "unit", empty, 10 * MINUTE),
  "maintenance.announcements": job(null, "control", "fanout", empty, MINUTE, () => "", 1),
  "maintenance.announcements.backup": job(
    null,
    "compute",
    "unit",
    announcementStep,
    10 * MINUTE,
    byStep,
    2,
  ),
  "maintenance.announcements.classify": job(
    null,
    "compute",
    "unit",
    backedUpStep,
    5 * MINUTE,
    byStep,
  ),
  "maintenance.announcements.delete": job(
    null,
    "compute",
    "unit",
    backedUpStep,
    5 * MINUTE,
    byStep,
  ),
  "maintenance.announcements.reindex": job(
    null,
    "compute",
    "unit",
    announcementStep,
    15 * MINUTE,
    byStep,
    1,
  ),
  "ops.digest": job(null, "control", "unit", empty, MINUTE),
  "documents.snapshot": job("documents", "control", "fanout", empty, 2 * MINUTE),
  "documents.revision": job(
    "documents",
    "io",
    "unit",
    z.object({ documentIds: z.array(z.number().int().positive()).min(1).max(100) }).strict(),
    4 * MINUTE,
    (p) => `${p.documentIds[0]}-${p.documentIds[p.documentIds.length - 1]}`,
  ),
  "documents.gc": job("documents", "compute", "unit", empty, 5 * MINUTE),
  "documents.release": job("documents", "compute", "unit", empty, 5 * MINUTE),
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
  priority?: number | undefined;
}

const envelopeSchema = z
  .object({
    type: z.string(),
    payload: z.record(z.unknown()).default({}),
    campaignId: z.number().int().positive().nullable().default(null),
    runId: z.number().int().positive().nullable().default(null),
    attemptBase: z.number().int().min(0).default(0),
    deferrals: z.number().int().min(0).default(0),
    priority: z.number().int().optional(),
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
