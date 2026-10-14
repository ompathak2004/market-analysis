import { sql } from "@ma/db";
import {
  executionMonths,
  LLM_EXTRACTOR_VERSION_BASE,
  ORDER_RELATIONSHIP_EXTRACTOR_VERSION,
  orderPeriod,
} from "@ma/ingest";
import type { LlmSource } from "./extract.js";
import { ORDERS_SYSTEM } from "./prompts.js";
import type { Cue } from "./sections.js";

export const ORDER_LLM_EXTRACTOR_VERSION = LLM_EXTRACTOR_VERSION_BASE + 1;

const ORDER_CUES: readonly Cue[] = [
  [
    /\b(?:orders?|contracts?|LoA|LoI|NoA|letters? of (?:award|intent|acceptance)|tenders?|projects?)\b/gi,
    2,
  ],
  [/\b(?:award(?:ed|s)?|bag(?:ged|s)|secur(?:ed|es)|receiv(?:ed|es)|won|wins?|placed)\b/gi, 1],
  [/\b(?:L-?1|lowest bidder)\b/gi, 2],
  [/(?:\bRs\.?|\bINR|\bUSD|₹)\s?[\d,.]+/gi, 1],
];

const REGEX_FOUND_NOTHING = sql`exists (
    select 1 from relationship_extractions x
    where x.document_revision_id = d.current_revision_id and x.extractor_family = rs.family
      and x.extractor_version = ${ORDER_RELATIONSHIP_EXTRACTOR_VERSION} and x.status = 'succeeded')
  and not exists (
    select 1 from relationship_extractions x
    where x.document_revision_id = d.current_revision_id and x.extractor_family = rs.family
      and x.extractor_version = ${ORDER_RELATIONSHIP_EXTRACTOR_VERSION} and x.status = 'succeeded'
      and x.observations > 0)
  and (rs.family = 'order_filing' or not exists (
    select 1 from announcements a
    join documents od on od.url = a.attachment_url and od.current_revision_id is not null
    where d.url = 'nse://announcement/' || a.id))`;

export const ORDER_LLM_SOURCE: LlmSource = {
  name: "orders",
  extractorVersion: ORDER_LLM_EXTRACTOR_VERSION,
  system: ORDERS_SYSTEM,
  cues: ORDER_CUES,
  sectionTokens: 2_500,
  maxOutputTokens: 800,
  maxConfidence: 0.85,
  minScore: 2,
  thirdParty: false,
  roles: ["customer"],
  markRead: false,
  families: ["order_filing", "announcement_metadata"],
  pendingWhere: REGEX_FOUND_NOTHING,
  period: (doc, text) =>
    doc.publishedAt
      ? orderPeriod(new Date(`${doc.publishedAt}T00:00:00Z`), executionMonths(text))
      : { start: null, end: null, fiscalYear: null },
};
