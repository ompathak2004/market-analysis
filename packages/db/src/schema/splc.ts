import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  serial,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import {
  companies,
  costBucket,
  disclosedBy,
  disclosureKind,
  documents,
  estimateMethod,
  periodType,
  timestamps,
} from "../schema.js";
import { documentRevisions, evidenceSpans } from "./evidence.js";

export const counterpartyKind = pgEnum("counterparty_kind", [
  "listed",
  "private",
  "government",
  "foreign",
  "group",
]);
export const aliasSource = pgEnum("alias_source", ["registry", "curated", "reviewer", "extracted"]);
export const relationshipFamily = pgEnum("relationship_family", [
  "legacy",
  "annual_report",
  "concall",
  "order_filing",
  "announcement_metadata",
  "rating_rationale",
  "presentation",
  "screener",
  "manual",
]);
export const extractionStatus = pgEnum("extraction_status", [
  "running",
  "succeeded",
  "failed",
  "deferred",
]);
export const observationStatus = pgEnum("observation_status", [
  "pending",
  "auto",
  "confirmed",
  "rejected",
  "blocked",
  "superseded",
]);
export const valueBasis = pgEnum("value_basis", [
  "revenue_share",
  "purchase_share",
  "annual_flow",
  "contract_total",
  "unknown",
]);
export const relationshipStatus = pgEnum("relationship_status", [
  "active",
  "expired",
  "superseded",
  "blocked",
  "legacy",
]);
export const reviewDecision = pgEnum("review_decision", ["confirm", "reject", "block"]);
export const orderStatus = pgEnum("order_status", ["awarded", "pending", "cancelled"]);
export const financialMetric = pgEnum("financial_metric", [
  "revenue",
  "cogs",
  "purchases",
  "capex",
  "sga",
  "rnd",
  "related_party_sales",
  "related_party_purchases",
]);

export const counterparties = pgTable(
  "counterparties",
  {
    id: serial("id").primaryKey(),
    kind: counterpartyKind("kind").notNull(),
    canonicalName: text("canonical_name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    companyId: integer("company_id").references(() => companies.id, { onDelete: "set null" }),
    country: text("country"),
    sector: text("sector"),
    groupKey: text("group_key"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("counterparties_normalized_uq").on(t.normalizedName),
    uniqueIndex("counterparties_company_uq").on(t.companyId),
    index("counterparties_group_idx").on(t.groupKey),
  ],
);

export const counterpartyIdentifiers = pgTable(
  "counterparty_identifiers",
  {
    counterpartyId: integer("counterparty_id")
      .notNull()
      .references(() => counterparties.id, { onDelete: "cascade" }),
    scheme: text("scheme").notNull(),
    value: text("value").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.scheme, t.value] }),
    index("counterparty_identifiers_cp_idx").on(t.counterpartyId),
  ],
);

export const counterpartyAliases = pgTable(
  "counterparty_aliases",
  {
    counterpartyId: integer("counterparty_id")
      .notNull()
      .references(() => counterparties.id, { onDelete: "cascade" }),
    alias: text("alias").notNull(),
    normalizedAlias: text("normalized_alias").notNull(),
    source: aliasSource("source").notNull(),
    approved: boolean("approved").notNull().default(false),
    exactCase: boolean("exact_case").notNull().default(false),
    createdAt: timestamps.createdAt,
  },
  (t) => [
    primaryKey({ columns: [t.counterpartyId, t.normalizedAlias] }),
    index("counterparty_aliases_norm_idx").on(t.normalizedAlias),
  ],
);

export const companyGroupMemberships = pgTable(
  "company_group_memberships",
  {
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    groupKey: text("group_key").notNull(),
    source: text("source").notNull(),
    validFrom: date("valid_from"),
    validTo: date("valid_to"),
    createdAt: timestamps.createdAt,
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.groupKey] }),
    index("company_group_memberships_group_idx").on(t.groupKey),
  ],
);

export const relationshipSources = pgTable(
  "relationship_sources",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    family: relationshipFamily("family").notNull(),
    documentId: integer("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    label: text("label"),
    publishedAt: date("published_at"),
    readRevisionId: bigint("read_revision_id", { mode: "number" }).references(
      () => documentRevisions.id,
      { onDelete: "set null" },
    ),
    readExtractorVersion: smallint("read_extractor_version"),
    lastReadAt: timestamp("last_read_at", { withTimezone: true }),
    lastError: text("last_error"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("relationship_sources_uq").on(t.companyId, t.family, t.documentId),
    index("relationship_sources_pending_idx").on(t.family, t.lastReadAt),
  ],
);

export const relationshipExtractions = pgTable(
  "relationship_extractions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    documentRevisionId: bigint("document_revision_id", { mode: "number" })
      .notNull()
      .references(() => documentRevisions.id, { onDelete: "cascade" }),
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    extractorFamily: relationshipFamily("extractor_family").notNull(),
    extractorVersion: smallint("extractor_version").notNull(),
    inputsHash: text("inputs_hash").notNull(),
    status: extractionStatus("status").notNull().default("running"),
    observations: integer("observations").notNull().default(0),
    dropped: integer("dropped").notNull().default(0),
    tokens: integer("tokens").notNull().default(0),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("relationship_extractions_uq").on(
      t.documentRevisionId,
      t.extractorFamily,
      t.extractorVersion,
      t.inputsHash,
    ),
    index("relationship_extractions_company_idx").on(t.companyId, t.extractorFamily),
  ],
);

export const relationshipObservations = pgTable(
  "relationship_observations",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    extractionId: bigint("extraction_id", { mode: "number" })
      .notNull()
      .references(() => relationshipExtractions.id, { onDelete: "cascade" }),
    focalCompanyId: integer("focal_company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    supplierCounterpartyId: integer("supplier_counterparty_id")
      .notNull()
      .references(() => counterparties.id, { onDelete: "cascade" }),
    customerCounterpartyId: integer("customer_counterparty_id")
      .notNull()
      .references(() => counterparties.id, { onDelete: "cascade" }),
    disclosedBy: disclosedBy("disclosed_by").notNull(),
    disclosureKind: disclosureKind("disclosure_kind").notNull(),
    costBucket: costBucket("cost_bucket").notNull().default("UNKNOWN"),
    valueBasis: valueBasis("value_basis").notNull().default("unknown"),
    cueClass: text("cue_class").notNull(),
    pct: real("pct"),
    valueCr: numeric("value_cr", { precision: 18, scale: 2 }),
    currency: text("currency"),
    periodStart: date("period_start"),
    periodEnd: date("period_end"),
    fiscalYear: smallint("fiscal_year"),
    orderStatus: orderStatus("order_status"),
    claim: text("claim").notNull(),
    confidence: real("confidence").notNull(),
    status: observationStatus("status").notNull().default("pending"),
    newCounterparty: boolean("new_counterparty").notNull().default(false),
    createdAt: timestamps.createdAt,
  },
  (t) => [
    index("relationship_observations_extraction_idx").on(t.extractionId),
    index("relationship_observations_pair_idx").on(
      t.supplierCounterpartyId,
      t.customerCounterpartyId,
      t.status,
    ),
    index("relationship_observations_review_idx").on(t.status, t.confidence, t.createdAt),
    check(
      "relationship_observations_pct_ck",
      sql`${t.pct} is null or (${t.pct} > 0 and ${t.pct} <= 100)`,
    ),
    check("relationship_observations_value_ck", sql`${t.valueCr} is null or ${t.valueCr} >= 0`),
    check(
      "relationship_observations_pair_ck",
      sql`${t.supplierCounterpartyId} <> ${t.customerCounterpartyId}`,
    ),
  ],
);

export const relationshipObservationEvidence = pgTable(
  "relationship_observation_evidence",
  {
    observationId: bigint("observation_id", { mode: "number" })
      .notNull()
      .references(() => relationshipObservations.id, { onDelete: "cascade" }),
    evidenceSpanId: bigint("evidence_span_id", { mode: "number" })
      .notNull()
      .references(() => evidenceSpans.id, { onDelete: "restrict" }),
  },
  (t) => [
    primaryKey({ columns: [t.observationId, t.evidenceSpanId] }),
    index("relationship_observation_evidence_span_idx").on(t.evidenceSpanId),
  ],
);

export const relationshipBlocks = pgTable(
  "relationship_blocks",
  {
    id: serial("id").primaryKey(),
    supplierCounterpartyId: integer("supplier_counterparty_id")
      .notNull()
      .references(() => counterparties.id, { onDelete: "cascade" }),
    customerCounterpartyId: integer("customer_counterparty_id")
      .notNull()
      .references(() => counterparties.id, { onDelete: "cascade" }),
    reason: text("reason").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamps.createdAt,
  },
  (t) => [
    uniqueIndex("relationship_blocks_pair_uq").on(
      t.supplierCounterpartyId,
      t.customerCounterpartyId,
    ),
  ],
);

export const relationships = pgTable(
  "relationships",
  {
    id: serial("id").primaryKey(),
    supplierCompanyId: integer("supplier_company_id").references(() => companies.id, {
      onDelete: "set null",
    }),
    supplierName: text("supplier_name").notNull(),
    customerCompanyId: integer("customer_company_id").references(() => companies.id, {
      onDelete: "set null",
    }),
    customerName: text("customer_name").notNull(),
    supplierCounterpartyId: integer("supplier_counterparty_id").references(
      () => counterparties.id,
      { onDelete: "set null" },
    ),
    customerCounterpartyId: integer("customer_counterparty_id").references(
      () => counterparties.id,
      { onDelete: "set null" },
    ),
    edgeKey: text("edge_key"),
    costBucket: costBucket("cost_bucket").notNull().default("UNKNOWN"),
    disclosedBy: disclosedBy("disclosed_by").notNull(),
    disclosureKind: disclosureKind("disclosure_kind").notNull(),
    disclosedPct: real("disclosed_pct"),
    disclosedValue: numeric("disclosed_value", { precision: 18, scale: 2 }),
    valueBasis: valueBasis("value_basis").notNull().default("unknown"),
    fiscalYear: smallint("fiscal_year"),
    validFrom: date("valid_from").notNull(),
    validTo: date("valid_to").notNull(),
    confidence: real("confidence").notNull(),
    evidence: text("evidence"),
    sourceDocumentId: integer("source_document_id").references(() => documents.id, {
      onDelete: "set null",
    }),
    extractorFamily: relationshipFamily("extractor_family").notNull().default("legacy"),
    extractorVersion: smallint("extractor_version").notNull().default(0),
    graphRevision: integer("graph_revision").notNull().default(0),
    status: relationshipStatus("status").notNull().default("legacy"),
    supersededById: integer("superseded_by_id"),
    lastDisclosedAt: date("last_disclosed_at"),
    observationCount: integer("observation_count").notNull().default(0),
    ...timestamps,
  },
  (t) => [
    index("relationships_supplier_idx").on(t.supplierCompanyId, t.validTo),
    index("relationships_customer_idx").on(t.customerCompanyId, t.validTo),
    index("relationships_status_idx").on(t.status, t.validTo),
    uniqueIndex("relationships_edge_key_uq").on(t.edgeKey),
    uniqueIndex("relationships_dedupe_uq").on(
      t.supplierName,
      t.customerName,
      t.disclosureKind,
      t.fiscalYear,
      t.sourceDocumentId,
    ),
  ],
);

export const relationshipEstimates = pgTable(
  "relationship_estimates",
  {
    id: serial("id").primaryKey(),
    relationshipId: integer("relationship_id")
      .notNull()
      .references(() => relationships.id, { onDelete: "cascade" }),
    asOf: date("as_of").notNull(),
    method: estimateMethod("method").notNull(),
    valueBasis: valueBasis("value_basis").notNull().default("annual_flow"),
    periodStart: date("period_start"),
    periodEnd: date("period_end"),
    valueCr: numeric("value_cr", { precision: 18, scale: 2 }),
    valueLowCr: numeric("value_low_cr", { precision: 18, scale: 2 }),
    valueHighCr: numeric("value_high_cr", { precision: 18, scale: 2 }),
    supplierRevenuePct: real("supplier_revenue_pct"),
    customerCostPct: real("customer_cost_pct"),
    inputs: jsonb("inputs").$type<Record<string, unknown>>().notNull(),
    inputsHash: text("inputs_hash"),
    modelVersion: smallint("model_version").notNull(),
    createdAt: timestamps.createdAt,
  },
  (t) => [
    uniqueIndex("relationship_estimates_uq").on(
      t.relationshipId,
      t.asOf,
      t.modelVersion,
      t.valueBasis,
    ),
    check(
      "relationship_estimates_nonneg_ck",
      sql`coalesce(${t.valueCr}, 0) >= 0 and coalesce(${t.valueLowCr}, 0) >= 0 and coalesce(${t.valueHighCr}, 0) >= 0`,
    ),
    check(
      "relationship_estimates_order_ck",
      sql`(${t.valueLowCr} is null or ${t.valueCr} is null or ${t.valueLowCr} <= ${t.valueCr})
        and (${t.valueHighCr} is null or ${t.valueCr} is null or ${t.valueCr} <= ${t.valueHighCr})`,
    ),
  ],
);

export const relationshipPriors = pgTable(
  "relationship_priors",
  {
    id: serial("id").primaryKey(),
    supplierSector: text("supplier_sector").notNull(),
    costBucket: costBucket("cost_bucket").notNull(),
    cueClass: text("cue_class").notNull(),
    disclosures: integer("disclosures").notNull(),
    suppliers: integer("suppliers").notNull(),
    shareP25: real("share_p25").notNull(),
    shareP50: real("share_p50").notNull(),
    shareP75: real("share_p75").notNull(),
    modelVersion: smallint("model_version").notNull(),
    builtAt: timestamp("built_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("relationship_priors_uq").on(
      t.supplierSector,
      t.costBucket,
      t.cueClass,
      t.modelVersion,
    ),
  ],
);

export const relationshipReviews = pgTable(
  "relationship_reviews",
  {
    id: serial("id").primaryKey(),
    observationId: bigint("observation_id", { mode: "number" })
      .notNull()
      .references(() => relationshipObservations.id, { onDelete: "cascade" }),
    relationshipId: integer("relationship_id").references(() => relationships.id, {
      onDelete: "set null",
    }),
    decision: reviewDecision("decision").notNull(),
    reviewer: text("reviewer").notNull(),
    note: text("note"),
    createdAt: timestamps.createdAt,
  },
  (t) => [index("relationship_reviews_observation_idx").on(t.observationId, t.createdAt)],
);

export const relationshipFinancialFacts = pgTable(
  "relationship_financial_facts",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    periodEnd: date("period_end").notNull(),
    periodType: periodType("period_type").notNull(),
    metric: financialMetric("metric").notNull(),
    valueCr: numeric("value_cr", { precision: 18, scale: 2 }).notNull(),
    sourceRevisionId: bigint("source_revision_id", { mode: "number" }).references(
      () => documentRevisions.id,
      { onDelete: "set null" },
    ),
    parserVersion: smallint("parser_version").notNull(),
    createdAt: timestamps.createdAt,
  },
  (t) => [
    uniqueIndex("relationship_financial_facts_uq").on(
      t.companyId,
      t.periodEnd,
      t.periodType,
      t.metric,
    ),
  ],
);

export const companyGraphState = pgTable("company_graph_state", {
  companyId: integer("company_id")
    .primaryKey()
    .references(() => companies.id, { onDelete: "cascade" }),
  graphRevision: integer("graph_revision").notNull().default(0),
  extractorVersion: smallint("extractor_version").notNull().default(0),
  documentsAvailable: integer("documents_available").notNull().default(0),
  documentsRead: integer("documents_read").notNull().default(0),
  observations: integer("observations").notNull().default(0),
  edges: integer("edges").notNull().default(0),
  lastDisclosedAt: date("last_disclosed_at"),
  rebuiltAt: timestamp("rebuilt_at", { withTimezone: true }),
  updatedAt: timestamps.updatedAt,
});
