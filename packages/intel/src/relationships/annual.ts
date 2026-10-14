import { fiscalPeriod, fiscalYearFromLabel, LLM_EXTRACTOR_VERSION_BASE } from "@ma/ingest";
import { type LlmSource, pendingLlmDocuments } from "./extract.js";
import { ANNUAL_SYSTEM } from "./prompts.js";
import { type Cue, RELATIONSHIP_CUES } from "./sections.js";

export const ANNUAL_LLM_EXTRACTOR_VERSION = LLM_EXTRACTOR_VERSION_BASE + 1;

const ANNUAL_CUES: readonly Cue[] = [
  ...RELATIONSHIP_CUES,
  [/\bInd\s?AS\s?108\b/gi, 3],
  [/\b(?:single|one) (?:external )?customer\b/gi, 3],
  [/\b10\s*(?:%|per ?cent) or more\b/gi, 3],
  [/\b(?:purchases?|sales?) of (?:goods|materials|products|services|raw materials)\b/gi, 2],
];

export const ANNUAL_LLM_SOURCE: LlmSource = {
  name: "annual_report",
  extractorVersion: ANNUAL_LLM_EXTRACTOR_VERSION,
  system: ANNUAL_SYSTEM,
  cues: ANNUAL_CUES,
  sectionTokens: 7_000,
  maxOutputTokens: 1_500,
  maxConfidence: 0.85,
  minScore: 4,
  thirdParty: false,
  roles: ["customer", "supplier"],
  markRead: false,
  families: ["annual_report"],
  pending: (db, scope) =>
    pendingLlmDocuments(db, scope, {
      families: ["annual_report"],
      extractorVersion: ANNUAL_LLM_EXTRACTOR_VERSION,
    }),
  period: (doc) => {
    const fy = doc.label ? fiscalYearFromLabel(doc.label) : null;
    return fy === null
      ? { start: null, end: null, fiscalYear: null }
      : { ...fiscalPeriod(fy), fiscalYear: fy };
  },
};
