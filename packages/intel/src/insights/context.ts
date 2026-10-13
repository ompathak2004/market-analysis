import type { RedisClient } from "@ma/cache";
import { type Logger, type ServiceConfig, throwIfAborted } from "@ma/core";
import { and, type Db, eq, insights, isNull, sql } from "@ma/db";
import type { LlmClient } from "@ma/llm";

export interface IntelContext {
  db: Db;
  redis: RedisClient;
  llm: LlmClient;
  logger: Logger;
  config: ServiceConfig;
}

export type InsightRow = typeof insights.$inferSelect;
export type InsightOutcome = InsightRow | "fresh" | "skipped";

export const COOLDOWN_MS = 24 * 3_600_000;

export interface NewInsight {
  companyId: number | null;
  kind: string;
  subjectId?: number | null;
  modelVersion: number;
  model: string;
  inputHash: string;
  inputs: Record<string, unknown>;
  output: Record<string, unknown>;
  confidence: number | null;
  promptTokens: number;
  completionTokens: number;
}

export async function writeCurrentInsight(db: Db, row: NewInsight): Promise<InsightRow> {
  throwIfAborted();
  return db.transaction(async (tx) => {
    await tx
      .update(insights)
      .set({ supersededAt: sql`now()` })
      .where(
        and(
          eq(insights.kind, row.kind),
          row.companyId == null
            ? isNull(insights.companyId)
            : eq(insights.companyId, row.companyId),
          row.subjectId == null
            ? isNull(insights.subjectId)
            : eq(insights.subjectId, row.subjectId),
          isNull(insights.supersededAt),
        ),
      );
    const [created] = await tx
      .insert(insights)
      .values({ ...row, subjectId: row.subjectId ?? null })
      .returning();
    if (!created) throw new Error(`insight insert failed for ${row.kind}`);
    return created;
  });
}

export interface RegenPolicy {
  force: boolean;
  material: boolean;
  cooldownMs?: number;
  now?: number;
}

export function shouldRegenerate(
  row: InsightRow | null,
  hash: string,
  modelVersion: number,
  policy: RegenPolicy,
): boolean {
  if (!row || policy.force || row.modelVersion !== modelVersion) return true;
  if (row.inputHash === hash) return false;
  if (policy.material) return true;
  const age = (policy.now ?? Date.now()) - row.generatedAt.getTime();
  return age >= (policy.cooldownMs ?? COOLDOWN_MS);
}

const evidenceIdsIn = (list: unknown, pick?: (item: Record<string, unknown>) => boolean) =>
  new Set(
    (Array.isArray(list) ? list : [])
      .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
      .filter((x) => !pick || pick(x))
      .map((x) => x.evidenceId)
      .filter((id): id is string => typeof id === "string"),
  );

export function hasNewBrokerCall(
  previousInputs: unknown,
  brokers: ReadonlyArray<{ evidenceId: string }>,
): boolean {
  const seen = evidenceIdsIn((previousInputs as { brokers?: unknown } | null)?.brokers);
  return brokers.some((b) => !seen.has(b.evidenceId));
}

export function hasNewMaterialAnnouncement(
  previousInputs: unknown,
  announcements: ReadonlyArray<{ evidenceId: string; materiality: string | null }>,
): boolean {
  const high = (a: { materiality?: unknown }) => a.materiality === "high";
  const seen = evidenceIdsIn(
    (previousInputs as { announcements?: unknown } | null)?.announcements,
    high,
  );
  return announcements.some((a) => high(a) && !seen.has(a.evidenceId));
}
