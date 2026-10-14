import { LLM_EXTRACTOR_VERSION_BASE, maskOutsideRationale } from "@ma/ingest";
import { type LlmSource, publishedPeriod } from "./extract.js";
import { RATINGS_SYSTEM } from "./prompts.js";
import { type Cue, RELATIONSHIP_CUES } from "./sections.js";

export const RATING_LLM_EXTRACTOR_VERSION = LLM_EXTRACTOR_VERSION_BASE + 1;

const RATING_CUES: readonly Cue[] = [
  ...RELATIONSHIP_CUES,
  [/\b(?:customer|client|counterparty) concentration\b/gi, 3],
  [/\border ?book\b/gi, 2],
  [/\b(?:top|largest) (?:three|five|ten|3|5|10) (?:customers?|clients?)\b/gi, 3],
  [/\b(?:power purchase|offtake) agreements?\b/gi, 2],
  [/\b(?:key rating drivers|credit strengths|business profile)\b/gi, 1],
];

export const RATING_LLM_SOURCE: LlmSource = {
  name: "rating_rationale",
  extractorVersion: RATING_LLM_EXTRACTOR_VERSION,
  system: RATINGS_SYSTEM,
  cues: RATING_CUES,
  sectionTokens: 3_500,
  maxOutputTokens: 1_000,
  maxConfidence: 0.75,
  minScore: 3,
  thirdParty: true,
  roles: ["customer", "supplier"],
  markRead: true,
  families: ["rating_rationale"],
  prepare: maskOutsideRationale,
  period: (doc) => publishedPeriod(doc.publishedAt),
};
