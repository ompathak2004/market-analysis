import { DAY, throwIfAborted } from "@ma/core";
import { fencedTransaction, sql, stateLeadership } from "@ma/db";
import {
  CHIEF_MINISTERS_URL,
  type IngestContext,
  parseStateHeads,
  STATE_GOVERNMENT_PARSER_VERSION,
  stateDirectoryReviewedOn,
  stateDirectoryText,
} from "@ma/ingest";
import { spanFor } from "./store.js";

export async function syncStateLeadership(ctx: IngestContext, signal?: AbortSignal) {
  const doc = await ctx.docs.fetch(CHIEF_MINISTERS_URL, {
    source: "state_government",
    via: "firecrawl",
    maxAgeMs: 20 * 3600000,
    extract: stateDirectoryText,
    ...(signal ? { signal } : {}),
  });
  const rows = parseStateHeads(doc.text);
  const sourceReviewedOn = stateDirectoryReviewedOn(doc.text);
  const observedOn = doc.doc.fetchedAt.toISOString().slice(0, 10);
  if (
    sourceReviewedOn &&
    (sourceReviewedOn > observedOn ||
      Date.parse(observedOn) - Date.parse(sourceReviewedOn) > 30 * DAY)
  ) {
    throw new Error(
      "Chief-minister directory is stale or future-dated; keeping previous observations",
    );
  }
  return fencedTransaction(
    ctx.db,
    async (tx) => {
      for (const row of rows) {
        throwIfAborted(signal);
        const evidenceSpanId = await spanFor(tx, doc.revision.id, doc.text, row, {
          source: "state_government",
          stateCode: row.stateCode,
        });
        if (!evidenceSpanId) throw new Error("State leadership evidence missing");
        await tx
          .insert(stateLeadership)
          .values({
            stateCode: row.stateCode,
            stateName: row.stateName,
            headName: row.headName,
            observedOn,
            sourceReviewedOn,
            evidenceSpanId,
            parserVersion: STATE_GOVERNMENT_PARSER_VERSION,
            checkedAt: doc.doc.fetchedAt,
          })
          .onConflictDoUpdate({
            target: [stateLeadership.stateCode, stateLeadership.observedOn],
            set: {
              headName: sql`excluded.head_name`,
              evidenceSpanId: sql`excluded.evidence_span_id`,
              sourceReviewedOn: sql`excluded.source_reviewed_on`,
              checkedAt: sql`excluded.checked_at`,
              parserVersion: STATE_GOVERNMENT_PARSER_VERSION,
            },
          });
      }
      return { states: rows.length };
    },
    signal,
  );
}
