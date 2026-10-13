import { throwIfAborted } from "@ma/core";
import { analystCalls, companies, documents, eq, sql } from "@ma/db";
import { LlmInvalidOutput } from "@ma/llm";
import type { IntelContext } from "./context.js";
import { BROKER_THESIS_SYSTEM, groundingFeedback, inputMessage } from "./prompts.js";
import { BROKER_THESIS_MODEL_VERSION, type BrokerThesis, brokerThesisSchema } from "./schemas.js";
import {
  describeViolations,
  dropViolations,
  NO_EVIDENCE,
  type Violation,
  validateClaims,
} from "./validate.js";

const THESIS_ARRAYS = new Set(["keyPoints", "risks"]);

export const BROKER_REPORT_CHARS = 12_000;

export function reportExcerpt(content: string, limit = BROKER_REPORT_CHARS): string {
  return content
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, limit);
}

export function thesisSummary(t: BrokerThesis): string {
  return [t.keyPoints[0], t.targetBasis].filter(Boolean).join(" ").slice(0, 400);
}

const nullIfBlank = (v: string | null) => (v?.trim() ? v : null);

export function groundThesis(
  thesis: BrokerThesis,
  violations: readonly Violation[],
  input: unknown,
): BrokerThesis | null {
  if (!violations.length) return thesis;
  const { output } = dropViolations(thesis, violations, THESIS_ARRAYS);
  const cleaned: BrokerThesis = {
    ...output,
    targetBasis: nullIfBlank(output.targetBasis),
    estimatesChanged: nullIfBlank(output.estimatesChanged),
  };
  if (!brokerThesisSchema.safeParse(cleaned).success) return null;
  return validateClaims(cleaned, input, { known: NO_EVIDENCE }).length ? null : cleaned;
}

export async function summarizeBrokerReport(
  ctx: IntelContext,
  analystCallId: number,
): Promise<BrokerThesis | "skipped"> {
  const [row] = await ctx.db
    .select({
      call: analystCalls,
      symbol: companies.nseSymbol,
      name: companies.name,
      content: documents.content,
    })
    .from(analystCalls)
    .innerJoin(companies, eq(companies.id, analystCalls.companyId))
    .leftJoin(documents, eq(documents.id, analystCalls.reportDocumentId))
    .where(eq(analystCalls.id, analystCallId))
    .limit(1);
  if (!row) return "skipped";
  const text = row.content ? reportExcerpt(row.content) : "";
  if (text.length < 200) {
    await ctx.db
      .update(analystCalls)
      .set({ summaryModelVersion: BROKER_THESIS_MODEL_VERSION, summarizedAt: new Date() })
      .where(eq(analystCalls.id, analystCallId));
    return "skipped";
  }
  const c = row.call;
  const input = {
    company: { symbol: row.symbol ?? row.name, name: row.name },
    call: {
      broker: c.broker,
      publishedAt: c.publishedAt,
      rating: c.rating,
      priorRating: c.priorRating ?? null,
      target: c.targetPrice ?? null,
      priorTarget: c.priorTargetPrice ?? null,
      title: c.title ?? null,
    },
    reportText: text,
  };
  const ask = async (extra?: string) => {
    const res = await ctx.llm.complete({
      name: "broker_thesis",
      system: BROKER_THESIS_SYSTEM,
      user: inputMessage(input, extra),
      schema: brokerThesisSchema,
      maxOutputTokens: 2_000,
    });
    return {
      thesis: res.data,
      violations: validateClaims(res.data, input, { known: NO_EVIDENCE }),
    };
  };
  let result = await ask();
  if (result.violations.length)
    result = await ask(groundingFeedback(describeViolations(result.violations)));
  const thesis = groundThesis(result.thesis, result.violations, input);
  if (!thesis) throw new LlmInvalidOutput("broker_thesis", "no grounded key points");
  throwIfAborted();
  await ctx.db
    .update(analystCalls)
    .set({
      thesis: thesis as unknown as Record<string, unknown>,
      summary: sql`coalesce(${analystCalls.summary}, ${thesisSummary(thesis)})`,
      summaryModelVersion: BROKER_THESIS_MODEL_VERSION,
      summarizedAt: new Date(),
    })
    .where(eq(analystCalls.id, analystCallId));
  return thesis;
}
