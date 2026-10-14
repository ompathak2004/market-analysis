import { z } from "zod";

export const relationshipClaimSchema = z.object({
  evidenceId: z.string(),
  quote: z.string(),
  counterparty: z.string(),
  counterpartyKind: z.enum(["company", "government", "foreign"]),
  role: z.enum(["customer", "supplier"]),
  disclosureKind: z.enum(["major_customer", "related_party", "segment", "contract", "press"]),
  costBucket: z.enum(["COGS", "CAPEX", "SGA", "RND", "UNKNOWN"]),
  valueBasis: z.enum([
    "revenue_share",
    "purchase_share",
    "annual_flow",
    "contract_total",
    "unknown",
  ]),
  pct: z.number().nullable(),
  amount: z.string().nullable(),
  orderStatus: z.enum(["awarded", "pending", "cancelled"]).nullable(),
  confidence: z.number(),
});

export const relationshipExtractionSchema = z.object({
  claims: z.array(relationshipClaimSchema),
});

export type RelationshipClaim = z.infer<typeof relationshipClaimSchema>;
export type RelationshipExtraction = z.infer<typeof relationshipExtractionSchema>;
