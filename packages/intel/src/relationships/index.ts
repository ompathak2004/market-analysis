import type { Db } from "@ma/db";
import { ANNUAL_LLM_SOURCE } from "./annual.js";
import { CONCALL_LLM_SOURCE } from "./concall.js";
import {
  type LlmDocument,
  type LlmSource,
  llmDocumentCost,
  pendingLlmDocuments,
} from "./extract.js";
import { ORDER_LLM_SOURCE } from "./orders.js";
import { PRESENTATION_LLM_SOURCE } from "./presentations.js";
import { RATING_LLM_SOURCE } from "./ratings.js";

export * from "./annual.js";
export * from "./concall.js";
export * from "./extract.js";
export * from "./grounding.js";
export * from "./orders.js";
export * from "./presentations.js";
export * from "./prompts.js";
export * from "./ratings.js";
export * from "./schemas.js";
export * from "./sections.js";

export const LLM_SOURCE_NAMES = [
  "orders",
  "annual_report",
  "concall",
  "rating_rationale",
  "presentation",
] as const;

export type LlmSourceName = (typeof LLM_SOURCE_NAMES)[number];

export const LLM_SOURCES: Readonly<Record<LlmSourceName, LlmSource>> = {
  orders: ORDER_LLM_SOURCE,
  annual_report: ANNUAL_LLM_SOURCE,
  concall: CONCALL_LLM_SOURCE,
  rating_rationale: RATING_LLM_SOURCE,
  presentation: PRESENTATION_LLM_SOURCE,
};

export function isLlmSourceName(name: string): name is LlmSourceName {
  return (LLM_SOURCE_NAMES as readonly string[]).includes(name);
}

export interface PlannedLlmDocument {
  source: LlmSourceName;
  companyId: number;
  documentId: number;
  revisionId: number;
}

export function planLlmDocuments(
  queues: ReadonlyArray<{ source: LlmSourceName; docs: readonly LlmDocument[] }>,
  budgetTokens: number,
): PlannedLlmDocument[] {
  const planned: PlannedLlmDocument[] = [];
  const depth = Math.max(0, ...queues.map((q) => q.docs.length));
  let spend = 0;
  for (let i = 0; i < depth; i++) {
    for (const { source, docs } of queues) {
      const doc = docs[i];
      if (!doc) continue;
      const cost = llmDocumentCost(LLM_SOURCES[source]);
      if (spend + cost > budgetTokens) continue;
      spend += cost;
      planned.push({
        source,
        companyId: doc.companyId,
        documentId: doc.documentId,
        revisionId: doc.revisionId,
      });
    }
  }
  return planned;
}

export async function pendingLlmPlan(
  db: Db,
  sources: readonly LlmSourceName[],
  perSource: number,
  budgetTokens: number,
): Promise<PlannedLlmDocument[]> {
  const queues = await Promise.all(
    sources.map(async (source) => ({
      source,
      docs: await pendingLlmDocuments(db, LLM_SOURCES[source], {
        companyId: null,
        limit: perSource,
      }),
    })),
  );
  return planLlmDocuments(queues, budgetTokens);
}
