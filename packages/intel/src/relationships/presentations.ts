import { sql } from "@ma/db";
import { LLM_EXTRACTOR_VERSION_BASE } from "@ma/ingest";
import { type LlmSource, pendingLlmDocuments, publishedPeriod } from "./extract.js";
import { PRESENTATIONS_SYSTEM } from "./prompts.js";
import { type Cue, RELATIONSHIP_CUES } from "./sections.js";

export const PRESENTATION_LLM_EXTRACTOR_VERSION = LLM_EXTRACTOR_VERSION_BASE + 1;

const PRESENTATION_CUES: readonly Cue[] = [
  ...RELATIONSHIP_CUES,
  [/\b(?:key|marquee|select|our) (?:customers?|clients?)\b/gi, 3],
  [/\bclient(?:ele| base| list)\b/gi, 2],
];

const LATEST_DECK = sql`rs.document_id = (
  select l.document_id from relationship_sources l
  where l.company_id = rs.company_id and l.family = 'presentation'
  order by l.published_at desc nulls last, l.document_id desc
  limit 1)`;

export const PRESENTATION_LLM_SOURCE: LlmSource = {
  name: "presentation",
  extractorVersion: PRESENTATION_LLM_EXTRACTOR_VERSION,
  system: PRESENTATIONS_SYSTEM,
  cues: PRESENTATION_CUES,
  sectionTokens: 3_000,
  maxOutputTokens: 1_000,
  maxConfidence: 0.7,
  minScore: 3,
  thirdParty: false,
  roles: ["customer", "supplier"],
  markRead: true,
  families: ["presentation"],
  pending: (db, scope) =>
    pendingLlmDocuments(db, scope, {
      families: ["presentation"],
      extractorVersion: PRESENTATION_LLM_EXTRACTOR_VERSION,
      where: LATEST_DECK,
    }),
  period: (doc) => publishedPeriod(doc.publishedAt),
};
