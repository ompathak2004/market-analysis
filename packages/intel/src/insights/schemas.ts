import { z } from "zod";

export const INSIGHT_MODEL_VERSION = 1;

export const verdictLabel = z.enum(["bearish", "cautious", "neutral", "constructive", "bullish"]);
export type VerdictLabel = z.infer<typeof verdictLabel>;

export const VERDICT_BANDS: ReadonlyArray<{ max: number; label: VerdictLabel }> = [
  { max: 19, label: "bearish" },
  { max: 39, label: "cautious" },
  { max: 59, label: "neutral" },
  { max: 79, label: "constructive" },
  { max: 100, label: "bullish" },
];

export function verdictLabelFor(score: number): VerdictLabel {
  const s = Math.max(0, Math.min(100, score));
  return VERDICT_BANDS.find((b) => s <= b.max)?.label ?? "neutral";
}

const evidenceIds = z.array(z.string()).default([]);

export const companyBriefSchema = z.object({
  verdict: z.object({
    score: z.number().min(0).max(100),
    label: verdictLabel,
    confidence: z.number().min(0).max(1),
    oneLiner: z.string().min(1).max(240),
  }),
  thesis: z
    .array(z.object({ point: z.string().min(1), evidence: evidenceIds }))
    .min(3)
    .max(6),
  risks: z
    .array(
      z.object({
        point: z.string().min(1),
        severity: z.enum(["low", "medium", "high"]),
        evidence: evidenceIds,
      }),
    )
    .min(1)
    .max(4),
  catalysts: z
    .array(
      z.object({ point: z.string().min(1), when: z.string().nullable(), evidence: evidenceIds }),
    )
    .max(4),
  whatChanged: z.array(z.string()),
  valuation: z.object({
    read: z.string(),
    vsPeers: z.string().nullable(),
    vsConsensus: z.string().nullable(),
  }),
  supplyChain: z.object({ read: z.string().nullable() }),
  managementTravel: z.object({ read: z.string().nullable() }),
  logistics: z.object({ read: z.string().nullable() }),
  uncertainty: z.array(z.string()),
});
export type CompanyBrief = z.infer<typeof companyBriefSchema>;

export const brokerDigestSchema = z.object({
  consensusRead: z.string(),
  byBroker: z.array(
    z.object({
      broker: z.string(),
      stance: z.string(),
      says: z.string(),
      target: z.number().nullable(),
      changed: z.string().nullable(),
    }),
  ),
  divergence: z.object({
    description: z.string(),
    bullCase: z.string().nullable(),
    bearCase: z.string().nullable(),
  }),
  targetDispersion: z.object({
    low: z.number(),
    high: z.number(),
    mean: z.number(),
    spreadPct: z.number(),
    read: z.string(),
  }),
  revisionMomentum: z.object({ direction: z.enum(["up", "down", "flat"]), read: z.string() }),
});
export type BrokerDigest = z.infer<typeof brokerDigestSchema>;

export const marketBriefSchema = z.object({
  headline: z.string().min(1).max(200),
  bullets: z
    .array(z.object({ text: z.string(), evidence: evidenceIds }))
    .min(3)
    .max(6),
  sectorRotation: z.string(),
  breadth: z.string(),
  notableCalls: z.array(z.string()),
  riskFlags: z.array(z.string()),
});
export type MarketBrief = z.infer<typeof marketBriefSchema>;

export const triageCategory = z.enum([
  "results",
  "order",
  "capex",
  "m&a",
  "management",
  "regulatory",
  "capital",
  "litigation",
  "routine",
  "other",
]);
export const materiality = z.enum(["low", "medium", "high"]);

export const triageItemSchema = z.object({
  announcementId: z.number().int(),
  materiality,
  category: triageCategory,
  soWhat: z.string().max(160),
});
export type TriageItem = z.infer<typeof triageItemSchema>;
export const triageBatchSchema = z.object({ items: z.array(triageItemSchema) });

export const brokerThesisSchema = z.object({
  stance: z.enum(["bullish", "neutral", "bearish"]),
  keyPoints: z.array(z.string()).min(1).max(5),
  targetBasis: z.string().nullable(),
  risks: z.array(z.string()).max(4),
  estimatesChanged: z.string().nullable(),
});
export type BrokerThesis = z.infer<typeof brokerThesisSchema>;
export const BROKER_THESIS_MODEL_VERSION = 1;

export type RuleGroup =
  | "price"
  | "financials"
  | "industry"
  | "shareholding"
  | "consensus"
  | "supply_chain"
  | "alt_data";

export interface RuleInsight {
  id: string;
  group: RuleGroup;
  tone: "positive" | "negative" | "neutral";
  text: string;
  value: number | null;
  evidence: string[];
}

export type EvidenceKind =
  | "filing"
  | "broker_pdf"
  | "announcement"
  | "concall"
  | "source"
  | "altdata";

export interface Evidence {
  id: string;
  kind: EvidenceKind;
  label: string;
  url: string | null;
}

export type InsightKind =
  | "company_brief"
  | "broker_digest"
  | "market_brief"
  | "announcement_triage";
