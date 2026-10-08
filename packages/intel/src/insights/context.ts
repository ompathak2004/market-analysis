import type { RedisClient } from "@ma/cache";
import type { Config, Logger } from "@ma/core";
import { and, type Db, eq, insights, isNull, sql } from "@ma/db";
import type { LlmClient } from "@ma/llm";

export interface IntelContext {
  db: Db;
  redis: RedisClient;
  llm: LlmClient;
  logger: Logger;
  config: Config;
}

export type InsightRow = typeof insights.$inferSelect;
export type InsightOutcome = InsightRow | "fresh" | "skipped";

export const FRESH_MS = 24 * 3_600_000;

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

export const isFresh = (
  row: InsightRow | null,
  hash: string,
  modelVersion: number,
  now = Date.now(),
) =>
  !!row &&
  row.inputHash === hash &&
  row.modelVersion === modelVersion &&
  now - row.generatedAt.getTime() < FRESH_MS;
