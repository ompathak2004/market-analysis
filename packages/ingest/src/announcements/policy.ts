import {
  isMaterialAnnouncement,
  MATERIAL_EVENT_PATTERNS as MATERIAL,
  ROUTINE_ANNOUNCEMENT_PATTERNS as ROUTINE,
} from "@ma/core";

export const ANNOUNCEMENT_POLICY_VERSION = 1;
export const ESOP_ROUTINE_MAX_SHARES = 1_000_000;
export const FIVE_YEAR_RETENTION_YEARS = 5;

export const RETENTION_CLASSES = ["forever", "five_years", "noise", "review_hold"] as const;
export type RetentionClass = (typeof RETENTION_CLASSES)[number];
type ClassifiedRetention = Exclude<RetentionClass, "review_hold">;

export type AnnouncementCategory =
  | "order_win"
  | "results"
  | "board_meeting"
  | "credit_rating"
  | "shareholding"
  | "investor_presentation"
  | "concall_transcript"
  | "concall_recording"
  | "concall_schedule"
  | "trading_window"
  | "duplicate_share_certificate"
  | "loss_of_share_certificate"
  | "newspaper_publication"
  | "record_date"
  | "agm_egm"
  | "dividend"
  | "buyback"
  | "acquisition"
  | "rpt"
  | "resignation_appointment"
  | "esop_allotment"
  | "compliance_certificate"
  | "investor_complaints"
  | "share_capital_audit"
  | "iepf_transfer"
  | "secretarial_compliance"
  | "other";

export interface AnnouncementInput {
  subject: string;
  category?: string | null;
  details?: string | null;
}

export interface AnnouncementClassification {
  categoryKey: AnnouncementCategory;
  retentionClass: ClassifiedRetention;
}

export interface AnnouncementPolicyColumns {
  categoryKey: AnnouncementCategory;
  retentionClass: ClassifiedRetention;
  retainUntil: string | null;
  policyVersion: number;
}

interface Rule {
  key: AnnouncementCategory;
  patterns: readonly RegExp[];
  retention: ClassifiedRetention;
}

const re = (source: string) => new RegExp(source, "i");

const RULES: readonly Rule[] = [
  { key: "order_win", patterns: [MATERIAL.orderWin], retention: "forever" },
  { key: "concall_transcript", patterns: [re("transcript")], retention: "forever" },
  {
    key: "concall_recording",
    patterns: [re("(?:audio|video) recording|recording of")],
    retention: "five_years",
  },
  { key: "investor_presentation", patterns: [re("presentation")], retention: "forever" },
  {
    key: "board_meeting",
    patterns: [
      re("board meeting intimation|intimation of (?:the )?board meeting|prior intimation"),
    ],
    retention: "five_years",
  },
  {
    key: "results",
    patterns: [
      re(
        "financial results?|results? for the (?:quarter|year|half|period)|integrated filing.{0,3}financ|limited review|audited",
      ),
    ],
    retention: "forever",
  },
  {
    key: "credit_rating",
    patterns: [
      re("credit rating|ratings? (?:assigned|reaffirmed|revised|upgrade|downgrade|action)"),
    ],
    retention: "forever",
  },
  { key: "rpt", patterns: [re("related party")], retention: "forever" },
  { key: "acquisition", patterns: [MATERIAL.restructuring], retention: "forever" },
  {
    key: "resignation_appointment",
    patterns: [
      MATERIAL.leadership,
      re("appointment|change in (?:directors?|key managerial|management|auditor)|directorate"),
    ],
    retention: "forever",
  },
  { key: "buyback", patterns: [re("buy-?back")], retention: "five_years" },
  { key: "dividend", patterns: [re("dividend")], retention: "five_years" },
  { key: "trading_window", patterns: [ROUTINE.tradingWindow], retention: "noise" },
  {
    key: "loss_of_share_certificate",
    patterns: [ROUTINE.lossOfShareCertificate],
    retention: "noise",
  },
  {
    key: "duplicate_share_certificate",
    patterns: [ROUTINE.duplicateShareCertificate],
    retention: "noise",
  },
  { key: "newspaper_publication", patterns: [ROUTINE.newspaperPublication], retention: "noise" },
  { key: "compliance_certificate", patterns: [ROUTINE.complianceCertificate], retention: "noise" },
  { key: "investor_complaints", patterns: [ROUTINE.investorComplaints], retention: "noise" },
  {
    key: "share_capital_audit",
    patterns: [ROUTINE.shareCapitalReconciliation],
    retention: "noise",
  },
  { key: "iepf_transfer", patterns: [ROUTINE.iepf], retention: "noise" },
  {
    key: "secretarial_compliance",
    patterns: [ROUTINE.secretarialCompliance],
    retention: "five_years",
  },
  { key: "esop_allotment", patterns: [ROUTINE.esop], retention: "noise" },
  {
    key: "concall_schedule",
    patterns: [
      ROUTINE.analystMeet,
      re("con\\.? ?call|conference call|earnings call|investors? meet|analysts? meet"),
    ],
    retention: "noise",
  },
  { key: "record_date", patterns: [ROUTINE.recordDate], retention: "five_years" },
  {
    key: "agm_egm",
    patterns: [
      ROUTINE.votingResults,
      re("general meeting|\\bagm\\b|\\begm\\b|shareholders'? meeting|postal ballot|e-?voting"),
    ],
    retention: "five_years",
  },
  {
    key: "board_meeting",
    patterns: [re("board meeting|outcome of (?:the )?board")],
    retention: "five_years",
  },
  {
    key: "shareholding",
    patterns: [
      re(
        "shareholding|takeover regulations|\\bsast\\b|insider trading|regulation 29|regulation 31|pledge|encumbrance",
      ),
    ],
    retention: "five_years",
  },
];

const DETAILS_FALLBACK_KEYS: ReadonlySet<AnnouncementCategory> = new Set(["concall_schedule"]);
const DETAILS_WINDOW = 400;
const SHARE_COUNT = /(\d[\d,]*)\s*(?:fully paid[- ]up\s+)?(?:equity\s+)?(?:shares|options)/gi;

function match(text: string): Rule | null {
  return RULES.find((r) => r.patterns.some((p) => p.test(text))) ?? null;
}

function largestShareCount(text: string): number {
  let max = 0;
  for (const m of text.matchAll(SHARE_COUNT)) {
    const n = Number((m[1] ?? "").replace(/,/g, ""));
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max;
}

function settle(rule: Rule, input: AnnouncementInput, text: string): AnnouncementClassification {
  const result = { categoryKey: rule.key, retentionClass: rule.retention };
  if (rule.retention !== "noise") return result;
  if (isMaterialAnnouncement(input.subject, input.details)) {
    return { ...result, retentionClass: "five_years" };
  }
  if (rule.key === "esop_allotment" && largestShareCount(text) > ESOP_ROUTINE_MAX_SHARES) {
    return { ...result, retentionClass: "five_years" };
  }
  return result;
}

export function classifyAnnouncement(input: AnnouncementInput): AnnouncementClassification {
  const subject = input.subject.trim();
  const label = input.category && input.category !== input.subject ? input.category : "";
  const head = `${subject} ${label}`.trim();
  const details = (input.details ?? "").slice(0, DETAILS_WINDOW);
  const bySubject = match(head);
  if (bySubject && !DETAILS_FALLBACK_KEYS.has(bySubject.key)) {
    return settle(bySubject, input, `${head} ${details}`);
  }
  const byDetails = details ? match(details) : null;
  if (byDetails) return settle(byDetails, input, details);
  if (bySubject) return settle(bySubject, input, head);
  return { categoryKey: "other", retentionClass: "five_years" };
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function retainUntil(publishedAt: Date, retentionClass: RetentionClass): string | null {
  switch (retentionClass) {
    case "forever":
    case "review_hold":
      return null;
    case "noise":
      return isoDay(publishedAt);
    case "five_years": {
      const until = new Date(publishedAt.getTime());
      until.setUTCFullYear(until.getUTCFullYear() + FIVE_YEAR_RETENTION_YEARS);
      return isoDay(until);
    }
  }
}

export function announcementPolicy(
  input: AnnouncementInput & { publishedAt: Date },
): AnnouncementPolicyColumns {
  const { categoryKey, retentionClass } = classifyAnnouncement(input);
  return {
    categoryKey,
    retentionClass,
    retainUntil: retainUntil(input.publishedAt, retentionClass),
    policyVersion: ANNOUNCEMENT_POLICY_VERSION,
  };
}
