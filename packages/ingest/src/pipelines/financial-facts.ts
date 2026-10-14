import { DeadlineExceededError, throwIfAborted } from "@ma/core";
import { and, eq, fencedTransaction, relationshipFinancialFacts, sql } from "@ma/db";
import type { IngestContext } from "../context.js";
import {
  extractFinancialFacts,
  FINANCIAL_FACTS_PARSER_VERSION,
} from "../extract/financial-facts.js";
import { fiscalPeriod, looksLikeMarkup, maskMarkup } from "../extract/text.js";
import { fiscalYearFromLabel } from "./relationships.js";

export interface FinancialFactsSyncResult {
  documents: number;
  parsed: number;
  unparsed: number;
  failed: number;
  facts: number;
}

const FY_RANGE = /\b(20\d{2})\s*[-–/]\s*(20\d{2}|\d{2})\b/;

const ANNUAL_REPORTS = sql`
  select rs.company_id, d.id as document_id, d.current_revision_id as revision_id,
    d.content_type, rs.label
  from relationship_sources rs
  join documents d on d.id = rs.document_id
  where rs.family = 'annual_report' and d.current_revision_id is not null`;

const FACTS_UNREAD = sql`not exists (
  select 1 from relationship_financial_facts f
  where f.source_revision_id = a.revision_id
    and f.parser_version = ${FINANCIAL_FACTS_PARSER_VERSION})`;

export const FINANCIAL_FACTS_PENDING = sql`exists (
  select 1 from (${ANNUAL_REPORTS}) a
  where a.company_id = c.id and ${FACTS_UNREAD})`;

export async function syncFinancialFacts(
  ctx: Pick<IngestContext, "db" | "docs" | "logger">,
  companyId: number,
  signal?: AbortSignal,
): Promise<FinancialFactsSyncResult> {
  const rows = await ctx.db.execute<{
    document_id: number;
    revision_id: number | string;
    content_type: string | null;
    label: string | null;
  }>(sql`
    select a.document_id, a.revision_id, a.content_type, a.label
    from (${ANNUAL_REPORTS}) a
    where a.company_id = ${companyId} and ${FACTS_UNREAD}
    order by a.revision_id`);
  const result: FinancialFactsSyncResult = {
    documents: rows.length,
    parsed: 0,
    unparsed: 0,
    failed: 0,
    facts: 0,
  };
  for (const row of rows) {
    throwIfAborted(signal);
    const fy = row.label ? fiscalYearOf(row.label) : null;
    if (fy === null) {
      result.unparsed++;
      continue;
    }
    const revisionId = Number(row.revision_id);
    let text: string;
    try {
      const revision = await ctx.docs.revision(revisionId);
      if (!revision) throw new Error(`revision ${revisionId} missing`);
      text = await ctx.docs.text(revision);
    } catch (err) {
      if (err instanceof DeadlineExceededError) throw err;
      throwIfAborted(signal);
      ctx.logger.warn({ err, companyId, revisionId }, "annual report text unavailable");
      result.failed++;
      continue;
    }
    const periodEnd = fiscalPeriod(fy).end;
    const parsed = extractFinancialFacts(
      looksLikeMarkup(text, row.content_type) ? maskMarkup(text) : text,
      periodEnd,
    );
    if (!parsed) {
      result.unparsed++;
      continue;
    }
    await fencedTransaction(
      ctx.db,
      async (tx) => {
        await tx
          .delete(relationshipFinancialFacts)
          .where(
            and(
              eq(relationshipFinancialFacts.companyId, companyId),
              eq(relationshipFinancialFacts.sourceRevisionId, revisionId),
            ),
          );
        await tx
          .insert(relationshipFinancialFacts)
          .values(
            parsed.facts.map((f) => ({
              companyId,
              periodEnd,
              periodType: "annual" as const,
              metric: f.metric,
              valueCr: String(f.valueCr),
              sourceRevisionId: revisionId,
              parserVersion: FINANCIAL_FACTS_PARSER_VERSION,
            })),
          )
          .onConflictDoUpdate({
            target: [
              relationshipFinancialFacts.companyId,
              relationshipFinancialFacts.periodEnd,
              relationshipFinancialFacts.periodType,
              relationshipFinancialFacts.metric,
            ],
            set: {
              valueCr: sql`excluded.value_cr`,
              sourceRevisionId: sql`excluded.source_revision_id`,
              parserVersion: sql`excluded.parser_version`,
            },
            setWhere: sql`${relationshipFinancialFacts.sourceRevisionId} is null
              or ${relationshipFinancialFacts.sourceRevisionId} <= excluded.source_revision_id
              or ${relationshipFinancialFacts.parserVersion} < excluded.parser_version`,
          });
      },
      signal,
    );
    result.parsed++;
    result.facts += parsed.facts.length;
    ctx.logger.info(
      {
        companyId,
        revisionId,
        statement: parsed.statement,
        unit: parsed.unit,
        facts: parsed.facts.length,
      },
      "financial facts parsed",
    );
  }
  return result;
}

function fiscalYearOf(label: string): number | null {
  const range = FY_RANGE.exec(label);
  if (range) {
    const start = Number(range[1]);
    if (Number(range[2]) % 100 === (start + 1) % 100) return start + 1;
  }
  return fiscalYearFromLabel(label);
}
