import type { EdgeClaim, EdgeStatus, RptRelationshipClass } from "./types.js";

export const INFLUENCE_EVENT_RULE_VERSION = 1;
export const AUTO_CONFIRM_MIN_CONFIDENCE = 0.95;
export const MATERIAL_RPT_MIN_CR = 10;
export const MATERIAL_RPT_REVENUE_SHARE = 0.01;

export function edgeStatus(claim: EdgeClaim): EdgeStatus {
  return claim.source === "structured_primary" &&
    claim.identifier &&
    claim.confidence >= AUTO_CONFIRM_MIN_CONFIDENCE
    ? "confirmed"
    : "pending";
}

export function materialRptThresholdCr(revenueCr: number | null | undefined): number {
  if (revenueCr == null || !Number.isFinite(revenueCr) || revenueCr <= 0) {
    return MATERIAL_RPT_MIN_CR;
  }
  return Math.min(MATERIAL_RPT_MIN_CR, revenueCr * MATERIAL_RPT_REVENUE_SHARE);
}

export function isMaterialRpt(valueCr: number, revenueCr: number | null | undefined): boolean {
  return Number.isFinite(valueCr) && valueCr >= materialRptThresholdCr(revenueCr);
}

const KMP =
  /\b(key\s+manage(?:ment|rial)\s+personnel|kmp|directors?|relatives?\s+of|whole[-\s]?time|managing\s+director|chief\s+(?:executive|financial))\b/i;
const BENEFIT =
  /\b(post[-\s]?employment|gratuity|provident|superannuation|pension|benefit\s+(?:plans?|trusts?|funds?)|employees?['’]?\s+(?:welfare\s+)?trust)\b/i;
const GROUP =
  /\b(fellow\s+subsidiar|(?:subsidiar(?:y|ies)|associates?|joint\s+ventures?|step[-\s]?down|affiliates?)\s+(?:company\s+)?of\s+(?:the\s+)?(?:ultimate\s+)?(?:holding|parent|promoter)|group\s+compan|promoter\s+group|enterprises?\s+(?:over\s+which|controlled|having\s+significant)|entities?\s+(?:controlled|under\s+(?:common\s+)?control))/i;
const HOLDING =
  /\b((?:ultimate\s+)?holding\s+company|(?:ultimate\s+)?parent(?:\s+company)?|promoters?)\b/i;
const SUBSIDIARY = /\b(subsidiar(?:y|ies)|step[-\s]?down)\b/i;
const ASSOCIATE = /\b(associates?|joint\s+ventures?|jv)\b/i;

export function rptRelationshipClass(
  relationship: string | null | undefined,
): RptRelationshipClass {
  const text = (relationship ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "other";
  if (BENEFIT.test(text)) return "employee_benefit";
  if (GROUP.test(text)) return "group";
  if (KMP.test(text)) return "kmp";
  if (HOLDING.test(text)) return "holding";
  if (SUBSIDIARY.test(text)) return "subsidiary";
  if (ASSOCIATE.test(text)) return "associate_jv";
  return "other";
}

export const RPT_EDGE_CLASSES: ReadonlySet<RptRelationshipClass> = new Set([
  "holding",
  "group",
  "associate_jv",
  "kmp",
  "other",
]);
