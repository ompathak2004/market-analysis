import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  check,
  date,
  index,
  integer,
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
import { companies, timestamps } from "../schema.js";
import { documentRevisions, evidenceSpans } from "./evidence.js";
import { counterparties, extractionStatus } from "./splc.js";

export const personIdentifierScheme = pgEnum("person_identifier_scheme", [
  "lok_sabha_member",
  "rajya_sabha_member",
  "myneta_candidate",
  "assembly_member",
]);
export const graphNodeKind = pgEnum("graph_node_kind", [
  "person",
  "company",
  "counterparty",
  "policy_sector",
  "policy_event",
  "party",
]);
export const personRoleKind = pgEnum("person_role_kind", [
  "director",
  "independent_director",
  "md",
  "ceo",
  "cfo",
  "chairman",
  "promoter",
  "kmp",
  "other",
]);
export const influenceFactStatus = pgEnum("influence_fact_status", ["current", "past"]);
export const politicalOffice = pgEnum("political_office", [
  "mp_lok_sabha",
  "mp_rajya_sabha",
  "mla",
  "minister",
  "chief_minister",
  "party_office",
  "other",
]);
export const affidavitInterestKind = pgEnum("affidavit_interest_kind", [
  "directorship",
  "shareholding",
  "business_interest",
  "family_interest",
  "liability",
]);
export const electoralBondKind = pgEnum("electoral_bond_kind", ["purchase", "redemption"]);
export const policyEventSource = pgEnum("policy_event_source", ["pib", "egazette", "prs"]);
export const policyTagBasis = pgEnum("policy_tag_basis", ["rule", "llm"]);
export const influenceEdgeKind = pgEnum("influence_edge_kind", [
  "holds_office",
  "declared_interest",
  "declared_family",
  "director_of",
  "promoter_of",
  "owns",
  "related_party",
  "donated_to",
  "policy_applies_to",
  "operates_in_sector",
  "member_of_party",
]);
export const influenceEdgeStatus = pgEnum("influence_edge_status", [
  "pending",
  "confirmed",
  "rejected",
  "superseded",
]);
export const influenceDecision = pgEnum("influence_decision", ["confirm", "reject"]);
export const influenceFamily = pgEnum("influence_family", [
  "nse_governance",
  "nse_rpt",
  "shareholding",
  "group_membership",
  "annual_report",
  "parliament",
  "myneta",
  "eci_bonds",
  "pib",
  "egazette",
  "prs",
]);
export const influenceEventKind = pgEnum("influence_event_kind", [
  "office_gained",
  "office_lost",
  "material_rpt",
  "donation",
  "policy_change",
  "director_change",
]);

const revisionRef = () =>
  bigint("document_revision_id", { mode: "number" }).references(() => documentRevisions.id, {
    onDelete: "set null",
  });
const spanRef = () =>
  bigint("evidence_span_id", { mode: "number" }).references(() => evidenceSpans.id, {
    onDelete: "set null",
  });

export const persons = pgTable(
  "persons",
  {
    id: serial("id").primaryKey(),
    din: text("din"),
    canonicalName: text("canonical_name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    gender: text("gender"),
    birthYear: smallint("birth_year"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("persons_din_uq").on(t.din).where(sql`${t.din} is not null`),
    index("persons_normalized_idx").on(t.normalizedName),
    check("persons_din_ck", sql`${t.din} is null or ${t.din} ~ '^[0-9]{8}$'`),
    check(
      "persons_birth_year_ck",
      sql`${t.birthYear} is null or ${t.birthYear} between 1900 and 2100`,
    ),
  ],
);

export const personAliases = pgTable(
  "person_aliases",
  {
    personId: integer("person_id")
      .notNull()
      .references(() => persons.id, { onDelete: "cascade" }),
    alias: text("alias").notNull(),
    normalizedAlias: text("normalized_alias").notNull(),
    source: text("source").notNull(),
    createdAt: timestamps.createdAt,
  },
  (t) => [
    primaryKey({ columns: [t.personId, t.normalizedAlias] }),
    index("person_aliases_norm_idx").on(t.normalizedAlias),
  ],
);

export const personIdentifiers = pgTable(
  "person_identifiers",
  {
    scheme: personIdentifierScheme("scheme").notNull(),
    value: text("value").notNull(),
    personId: integer("person_id")
      .notNull()
      .references(() => persons.id, { onDelete: "cascade" }),
    documentRevisionId: revisionRef(),
    createdAt: timestamps.createdAt,
  },
  (t) => [
    primaryKey({ columns: [t.scheme, t.value] }),
    index("person_identifiers_person_idx").on(t.personId),
  ],
);

export const policySectors = pgTable("policy_sectors", {
  key: text("key").primaryKey(),
  label: text("label").notNull(),
  ministryKeys: text("ministry_keys").array().notNull().default(sql`'{}'::text[]`),
  createdAt: timestamps.createdAt,
});

export const companyPolicySectors = pgTable(
  "company_policy_sectors",
  {
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    sectorKey: text("sector_key")
      .notNull()
      .references(() => policySectors.key, { onDelete: "cascade" }),
    source: text("source").notNull(),
    evidenceSpanId: spanRef(),
    createdAt: timestamps.createdAt,
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.sectorKey] }),
    index("company_policy_sectors_sector_idx").on(t.sectorKey),
  ],
);

export const policyEvents = pgTable(
  "policy_events",
  {
    id: serial("id").primaryKey(),
    source: policyEventSource("source").notNull(),
    externalId: text("external_id").notNull(),
    title: text("title").notNull(),
    ministry: text("ministry"),
    stage: text("stage"),
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull(),
    url: text("url").notNull(),
    documentRevisionId: revisionRef(),
    inputHash: text("input_hash").notNull(),
    ...timestamps,
  },
  (t) => [
    unique("policy_events_external_uq").on(t.source, t.externalId),
    index("policy_events_published_idx").on(t.publishedAt),
  ],
);

export const graphNodes = pgTable(
  "graph_nodes",
  {
    id: serial("id").primaryKey(),
    kind: graphNodeKind("kind").notNull(),
    personId: integer("person_id").references(() => persons.id, { onDelete: "cascade" }),
    companyId: integer("company_id").references(() => companies.id, { onDelete: "cascade" }),
    counterpartyId: integer("counterparty_id").references(() => counterparties.id, {
      onDelete: "cascade",
    }),
    sectorKey: text("sector_key").references(() => policySectors.key, { onDelete: "cascade" }),
    policyEventId: integer("policy_event_id").references(() => policyEvents.id, {
      onDelete: "cascade",
    }),
    partyName: text("party_name"),
    createdAt: timestamps.createdAt,
  },
  (t) => [
    uniqueIndex("graph_nodes_person_uq").on(t.personId),
    uniqueIndex("graph_nodes_company_uq").on(t.companyId),
    uniqueIndex("graph_nodes_counterparty_uq").on(t.counterpartyId),
    uniqueIndex("graph_nodes_sector_uq").on(t.sectorKey),
    uniqueIndex("graph_nodes_policy_event_uq").on(t.policyEventId),
    uniqueIndex("graph_nodes_party_uq").on(t.partyName),
    check(
      "graph_nodes_one_ref_ck",
      sql`num_nonnulls(${t.personId}, ${t.companyId}, ${t.counterpartyId}, ${t.sectorKey}, ${t.policyEventId}, ${t.partyName}) = 1`,
    ),
    check(
      "graph_nodes_kind_ck",
      sql`case ${t.kind}
        when 'person' then ${t.personId} is not null
        when 'company' then ${t.companyId} is not null
        when 'counterparty' then ${t.counterpartyId} is not null
        when 'policy_sector' then ${t.sectorKey} is not null
        when 'policy_event' then ${t.policyEventId} is not null
        when 'party' then ${t.partyName} is not null
      end`,
    ),
  ],
);

export const personRoles = pgTable(
  "person_roles",
  {
    id: serial("id").primaryKey(),
    personId: integer("person_id")
      .notNull()
      .references(() => persons.id, { onDelete: "cascade" }),
    companyId: integer("company_id").references(() => companies.id, { onDelete: "cascade" }),
    counterpartyId: integer("counterparty_id").references(() => counterparties.id, {
      onDelete: "cascade",
    }),
    role: personRoleKind("role").notNull(),
    category: text("category"),
    dinSource: text("din_source"),
    fromDate: date("from_date"),
    toDate: date("to_date"),
    documentRevisionId: revisionRef(),
    evidenceSpanId: spanRef(),
    status: influenceFactStatus("status").notNull().default("current"),
    dedupeKey: text("dedupe_key").notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("person_roles_dedupe_uq").on(t.dedupeKey),
    index("person_roles_person_idx").on(t.personId),
    index("person_roles_company_idx").on(t.companyId, t.status),
    check("person_roles_target_ck", sql`num_nonnulls(${t.companyId}, ${t.counterpartyId}) = 1`),
    check(
      "person_roles_dates_ck",
      sql`${t.toDate} is null or ${t.fromDate} is null or ${t.fromDate} <= ${t.toDate}`,
    ),
  ],
);

export const ownership = pgTable(
  "ownership",
  {
    id: serial("id").primaryKey(),
    holderNodeId: integer("holder_node_id")
      .notNull()
      .references(() => graphNodes.id, { onDelete: "cascade" }),
    targetNodeId: integer("target_node_id")
      .notNull()
      .references(() => graphNodes.id, { onDelete: "cascade" }),
    pct: real("pct"),
    shares: bigint("shares", { mode: "number" }),
    asOf: date("as_of").notNull(),
    source: text("source").notNull(),
    documentRevisionId: revisionRef(),
    createdAt: timestamps.createdAt,
  },
  (t) => [
    unique("ownership_uq").on(t.holderNodeId, t.targetNodeId, t.asOf, t.source),
    index("ownership_target_idx").on(t.targetNodeId, t.asOf),
    check("ownership_pct_ck", sql`${t.pct} is null or (${t.pct} >= 0 and ${t.pct} <= 100)`),
    check("ownership_pair_ck", sql`${t.holderNodeId} <> ${t.targetNodeId}`),
  ],
);

export const relatedPartyTransactions = pgTable(
  "related_party_transactions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    counterpartyId: integer("counterparty_id").references(() => counterparties.id, {
      onDelete: "set null",
    }),
    counterpartyName: text("counterparty_name").notNull(),
    relationship: text("relationship"),
    transactionType: text("transaction_type"),
    valueCr: numeric("value_cr", { precision: 18, scale: 2 }),
    periodStart: date("period_start"),
    periodEnd: date("period_end"),
    scope: text("scope"),
    source: text("source").notNull(),
    documentRevisionId: revisionRef(),
    evidenceSpanId: spanRef(),
    dedupeKey: text("dedupe_key").notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("related_party_transactions_dedupe_uq").on(t.dedupeKey),
    index("related_party_transactions_company_idx").on(t.companyId, t.periodEnd),
    index("related_party_transactions_counterparty_idx").on(t.counterpartyId),
    check("related_party_transactions_value_ck", sql`${t.valueCr} is null or ${t.valueCr} >= 0`),
  ],
);

export const politicalRoles = pgTable(
  "political_roles",
  {
    id: serial("id").primaryKey(),
    personId: integer("person_id")
      .notNull()
      .references(() => persons.id, { onDelete: "cascade" }),
    office: politicalOffice("office").notNull(),
    party: text("party"),
    constituency: text("constituency"),
    state: text("state"),
    fromDate: date("from_date"),
    toDate: date("to_date"),
    source: text("source").notNull(),
    documentRevisionId: revisionRef(),
    status: influenceFactStatus("status").notNull().default("current"),
    dedupeKey: text("dedupe_key").notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("political_roles_dedupe_uq").on(t.dedupeKey),
    index("political_roles_person_idx").on(t.personId, t.status),
  ],
);

export const affidavitInterests = pgTable(
  "affidavit_interests",
  {
    id: serial("id").primaryKey(),
    personId: integer("person_id")
      .notNull()
      .references(() => persons.id, { onDelete: "cascade" }),
    kind: affidavitInterestKind("kind").notNull(),
    targetNodeId: integer("target_node_id").references(() => graphNodes.id, {
      onDelete: "set null",
    }),
    description: text("description").notNull(),
    valueCr: numeric("value_cr", { precision: 18, scale: 2 }),
    page: smallint("page"),
    documentRevisionId: revisionRef(),
    evidenceSpanId: spanRef(),
    dedupeKey: text("dedupe_key").notNull(),
    createdAt: timestamps.createdAt,
  },
  (t) => [
    uniqueIndex("affidavit_interests_dedupe_uq").on(t.dedupeKey),
    index("affidavit_interests_person_idx").on(t.personId),
    index("affidavit_interests_target_idx").on(t.targetNodeId),
  ],
);

export const electoralBondRows = pgTable(
  "electoral_bond_rows",
  {
    id: serial("id").primaryKey(),
    kind: electoralBondKind("kind").notNull(),
    bondPrefix: text("bond_prefix").notNull(),
    bondNumber: integer("bond_number").notNull(),
    denomination: bigint("denomination", { mode: "number" }).notNull(),
    date: date("date").notNull(),
    partyOrPurchaser: text("party_or_purchaser").notNull(),
    counterpartyId: integer("counterparty_id").references(() => counterparties.id, {
      onDelete: "set null",
    }),
    documentRevisionId: revisionRef(),
    page: smallint("page"),
    createdAt: timestamps.createdAt,
  },
  (t) => [
    unique("electoral_bond_rows_uq").on(t.kind, t.bondPrefix, t.bondNumber, t.denomination),
    index("electoral_bond_rows_counterparty_idx").on(t.counterpartyId),
    check("electoral_bond_rows_denomination_ck", sql`${t.denomination} > 0`),
  ],
);

export const politicalDonations = pgTable(
  "political_donations",
  {
    id: serial("id").primaryKey(),
    purchaseRowId: integer("purchase_row_id")
      .notNull()
      .references(() => electoralBondRows.id, { onDelete: "cascade" }),
    redemptionRowId: integer("redemption_row_id")
      .notNull()
      .references(() => electoralBondRows.id, { onDelete: "cascade" }),
    counterpartyId: integer("counterparty_id").references(() => counterparties.id, {
      onDelete: "set null",
    }),
    party: text("party").notNull(),
    amount: bigint("amount", { mode: "number" }).notNull(),
    matchedOn: text("matched_on").notNull(),
    createdAt: timestamps.createdAt,
  },
  (t) => [
    unique("political_donations_pair_uq").on(t.purchaseRowId, t.redemptionRowId),
    uniqueIndex("political_donations_purchase_uq").on(t.purchaseRowId),
    uniqueIndex("political_donations_redemption_uq").on(t.redemptionRowId),
    index("political_donations_counterparty_idx").on(t.counterpartyId),
    check("political_donations_amount_ck", sql`${t.amount} > 0`),
  ],
);

export const policyEventTags = pgTable(
  "policy_event_tags",
  {
    id: serial("id").primaryKey(),
    policyEventId: integer("policy_event_id")
      .notNull()
      .references(() => policyEvents.id, { onDelete: "cascade" }),
    sectorKey: text("sector_key").references(() => policySectors.key, { onDelete: "cascade" }),
    companyId: integer("company_id").references(() => companies.id, { onDelete: "cascade" }),
    basis: policyTagBasis("basis").notNull(),
    evidenceSpanId: spanRef(),
    confidence: real("confidence").notNull(),
    createdAt: timestamps.createdAt,
  },
  (t) => [
    unique("policy_event_tags_uq").on(t.policyEventId, t.sectorKey, t.companyId).nullsNotDistinct(),
    index("policy_event_tags_sector_idx").on(t.sectorKey),
    index("policy_event_tags_company_idx").on(t.companyId),
    check("policy_event_tags_target_ck", sql`num_nonnulls(${t.sectorKey}, ${t.companyId}) = 1`),
    check("policy_event_tags_confidence_ck", sql`${t.confidence} >= 0 and ${t.confidence} <= 1`),
  ],
);

export const influenceEdges = pgTable(
  "influence_edges",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    fromNodeId: integer("from_node_id")
      .notNull()
      .references(() => graphNodes.id, { onDelete: "cascade" }),
    toNodeId: integer("to_node_id")
      .notNull()
      .references(() => graphNodes.id, { onDelete: "cascade" }),
    kind: influenceEdgeKind("kind").notNull(),
    personRoleId: integer("person_role_id").references(() => personRoles.id, {
      onDelete: "cascade",
    }),
    ownershipId: integer("ownership_id").references(() => ownership.id, { onDelete: "cascade" }),
    rptId: bigint("rpt_id", { mode: "number" }).references(() => relatedPartyTransactions.id, {
      onDelete: "cascade",
    }),
    politicalRoleId: integer("political_role_id").references(() => politicalRoles.id, {
      onDelete: "cascade",
    }),
    affidavitInterestId: integer("affidavit_interest_id").references(() => affidavitInterests.id, {
      onDelete: "cascade",
    }),
    donationId: integer("donation_id").references(() => politicalDonations.id, {
      onDelete: "cascade",
    }),
    policyEventTagId: integer("policy_event_tag_id").references(() => policyEventTags.id, {
      onDelete: "cascade",
    }),
    confidence: real("confidence").notNull(),
    status: influenceEdgeStatus("status").notNull().default("pending"),
    resolverVersion: smallint("resolver_version").notNull(),
    inputHash: text("input_hash").notNull(),
    validFrom: date("valid_from"),
    validTo: date("valid_to"),
    version: integer("version").notNull().default(1),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("influence_edges_confirmed_uq")
      .on(t.fromNodeId, t.toNodeId, t.kind)
      .where(sql`${t.status} = 'confirmed'`),
    uniqueIndex("influence_edges_pending_uq")
      .on(t.fromNodeId, t.toNodeId, t.kind)
      .where(sql`${t.status} = 'pending'`),
    index("influence_edges_from_confirmed_idx")
      .on(t.fromNodeId)
      .where(sql`${t.status} = 'confirmed'`),
    index("influence_edges_to_confirmed_idx").on(t.toNodeId).where(sql`${t.status} = 'confirmed'`),
    index("influence_edges_review_idx").on(t.status, t.confidence, t.createdAt),
    check(
      "influence_edges_fact_ck",
      sql`num_nonnulls(${t.personRoleId}, ${t.ownershipId}, ${t.rptId}, ${t.politicalRoleId}, ${t.affidavitInterestId}, ${t.donationId}, ${t.policyEventTagId}) <= 1`,
    ),
    check("influence_edges_pair_ck", sql`${t.fromNodeId} <> ${t.toNodeId}`),
    check("influence_edges_confidence_ck", sql`${t.confidence} >= 0 and ${t.confidence} <= 1`),
    check(
      "influence_edges_valid_ck",
      sql`${t.validTo} is null or ${t.validFrom} is null or ${t.validFrom} <= ${t.validTo}`,
    ),
  ],
);

export const influenceEdgeEvidence = pgTable(
  "influence_edge_evidence",
  {
    edgeId: bigint("edge_id", { mode: "number" })
      .notNull()
      .references(() => influenceEdges.id, { onDelete: "cascade" }),
    evidenceSpanId: bigint("evidence_span_id", { mode: "number" })
      .notNull()
      .references(() => evidenceSpans.id, { onDelete: "restrict" }),
  },
  (t) => [
    primaryKey({ columns: [t.edgeId, t.evidenceSpanId] }),
    index("influence_edge_evidence_span_idx").on(t.evidenceSpanId),
  ],
);

export const influenceReviews = pgTable(
  "influence_reviews",
  {
    id: serial("id").primaryKey(),
    edgeId: bigint("edge_id", { mode: "number" })
      .notNull()
      .references(() => influenceEdges.id, { onDelete: "cascade" }),
    decision: influenceDecision("decision").notNull(),
    reviewer: text("reviewer").notNull(),
    note: text("note"),
    edgeVersion: integer("edge_version").notNull(),
    createdAt: timestamps.createdAt,
  },
  (t) => [index("influence_reviews_edge_idx").on(t.edgeId, t.createdAt)],
);

export const influenceExtractions = pgTable(
  "influence_extractions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    documentRevisionId: bigint("document_revision_id", { mode: "number" })
      .notNull()
      .references(() => documentRevisions.id, { onDelete: "cascade" }),
    companyId: integer("company_id").references(() => companies.id, { onDelete: "cascade" }),
    family: influenceFamily("family").notNull(),
    version: smallint("version").notNull(),
    inputHash: text("input_hash").notNull(),
    status: extractionStatus("status").notNull().default("running"),
    rows: integer("rows").notNull().default(0),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    unique("influence_extractions_uq").on(t.documentRevisionId, t.family, t.version, t.inputHash),
    index("influence_extractions_company_idx").on(t.companyId, t.family),
  ],
);

export const influenceEvents = pgTable(
  "influence_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    kind: influenceEventKind("kind").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    summary: text("summary").notNull(),
    ruleVersion: smallint("rule_version").notNull(),
    inputHash: text("input_hash").notNull(),
    createdAt: timestamps.createdAt,
  },
  (t) => [
    unique("influence_events_uq").on(t.companyId, t.kind, t.inputHash),
    index("influence_events_company_idx").on(t.companyId, t.occurredAt),
  ],
);

export const influenceEventEdges = pgTable(
  "influence_event_edges",
  {
    eventId: bigint("event_id", { mode: "number" })
      .notNull()
      .references(() => influenceEvents.id, { onDelete: "cascade" }),
    edgeId: bigint("edge_id", { mode: "number" })
      .notNull()
      .references(() => influenceEdges.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.eventId, t.edgeId] }),
    index("influence_event_edges_edge_idx").on(t.edgeId),
  ],
);

export const influenceCoverage = pgTable("influence_coverage", {
  companyId: integer("company_id")
    .primaryKey()
    .references(() => companies.id, { onDelete: "cascade" }),
  governanceReadAt: timestamp("governance_read_at", { withTimezone: true }),
  rptReadAt: timestamp("rpt_read_at", { withTimezone: true }),
  perimeterReadAt: timestamp("perimeter_read_at", { withTimezone: true }),
  affidavitsRead: integer("affidavits_read").notNull().default(0),
  bondsReadAt: timestamp("bonds_read_at", { withTimezone: true }),
  policyReadAt: timestamp("policy_read_at", { withTimezone: true }),
  resolverVersion: smallint("resolver_version"),
  updatedAt: timestamps.updatedAt,
});
