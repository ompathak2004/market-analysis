CREATE TYPE "public"."affidavit_interest_kind" AS ENUM('directorship', 'shareholding', 'business_interest', 'family_interest', 'liability');--> statement-breakpoint
CREATE TYPE "public"."electoral_bond_kind" AS ENUM('purchase', 'redemption');--> statement-breakpoint
CREATE TYPE "public"."graph_node_kind" AS ENUM('person', 'company', 'counterparty', 'policy_sector', 'policy_event', 'party');--> statement-breakpoint
CREATE TYPE "public"."influence_decision" AS ENUM('confirm', 'reject');--> statement-breakpoint
CREATE TYPE "public"."influence_edge_kind" AS ENUM('holds_office', 'declared_interest', 'declared_family', 'director_of', 'promoter_of', 'owns', 'related_party', 'donated_to', 'policy_applies_to', 'operates_in_sector', 'member_of_party');--> statement-breakpoint
CREATE TYPE "public"."influence_edge_status" AS ENUM('pending', 'confirmed', 'rejected', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."influence_event_kind" AS ENUM('office_gained', 'office_lost', 'material_rpt', 'donation', 'policy_change', 'director_change');--> statement-breakpoint
CREATE TYPE "public"."influence_fact_status" AS ENUM('current', 'past');--> statement-breakpoint
CREATE TYPE "public"."influence_family" AS ENUM('nse_governance', 'nse_rpt', 'shareholding', 'group_membership', 'annual_report', 'parliament', 'myneta', 'eci_bonds', 'pib', 'egazette', 'prs');--> statement-breakpoint
CREATE TYPE "public"."person_identifier_scheme" AS ENUM('lok_sabha_member', 'rajya_sabha_member', 'myneta_candidate', 'assembly_member');--> statement-breakpoint
CREATE TYPE "public"."person_role_kind" AS ENUM('director', 'independent_director', 'md', 'ceo', 'cfo', 'chairman', 'promoter', 'kmp', 'other');--> statement-breakpoint
CREATE TYPE "public"."policy_event_source" AS ENUM('pib', 'egazette', 'prs');--> statement-breakpoint
CREATE TYPE "public"."policy_tag_basis" AS ENUM('rule', 'llm');--> statement-breakpoint
CREATE TYPE "public"."political_office" AS ENUM('mp_lok_sabha', 'mp_rajya_sabha', 'mla', 'minister', 'chief_minister', 'party_office', 'other');--> statement-breakpoint
CREATE TABLE "affidavit_interests" (
	"id" serial PRIMARY KEY NOT NULL,
	"person_id" integer NOT NULL,
	"kind" "affidavit_interest_kind" NOT NULL,
	"target_node_id" integer,
	"description" text NOT NULL,
	"value_cr" numeric(18, 2),
	"page" smallint,
	"document_revision_id" bigint,
	"evidence_span_id" bigint,
	"dedupe_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "company_policy_sectors" (
	"company_id" integer NOT NULL,
	"sector_key" text NOT NULL,
	"source" text NOT NULL,
	"evidence_span_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_policy_sectors_company_id_sector_key_pk" PRIMARY KEY("company_id","sector_key")
);
--> statement-breakpoint
CREATE TABLE "electoral_bond_rows" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" "electoral_bond_kind" NOT NULL,
	"bond_prefix" text NOT NULL,
	"bond_number" integer NOT NULL,
	"denomination" bigint NOT NULL,
	"date" date NOT NULL,
	"party_or_purchaser" text NOT NULL,
	"counterparty_id" integer,
	"document_revision_id" bigint,
	"page" smallint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "electoral_bond_rows_uq" UNIQUE("kind","bond_prefix","bond_number","denomination"),
	CONSTRAINT "electoral_bond_rows_denomination_ck" CHECK ("electoral_bond_rows"."denomination" > 0)
);
--> statement-breakpoint
CREATE TABLE "graph_nodes" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" "graph_node_kind" NOT NULL,
	"person_id" integer,
	"company_id" integer,
	"counterparty_id" integer,
	"sector_key" text,
	"policy_event_id" integer,
	"party_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "graph_nodes_one_ref_ck" CHECK (num_nonnulls("graph_nodes"."person_id", "graph_nodes"."company_id", "graph_nodes"."counterparty_id", "graph_nodes"."sector_key", "graph_nodes"."policy_event_id", "graph_nodes"."party_name") = 1),
	CONSTRAINT "graph_nodes_kind_ck" CHECK (case "graph_nodes"."kind"
        when 'person' then "graph_nodes"."person_id" is not null
        when 'company' then "graph_nodes"."company_id" is not null
        when 'counterparty' then "graph_nodes"."counterparty_id" is not null
        when 'policy_sector' then "graph_nodes"."sector_key" is not null
        when 'policy_event' then "graph_nodes"."policy_event_id" is not null
        when 'party' then "graph_nodes"."party_name" is not null
      end)
);
--> statement-breakpoint
CREATE TABLE "influence_coverage" (
	"company_id" integer PRIMARY KEY NOT NULL,
	"governance_read_at" timestamp with time zone,
	"rpt_read_at" timestamp with time zone,
	"perimeter_read_at" timestamp with time zone,
	"affidavits_read" integer DEFAULT 0 NOT NULL,
	"bonds_read_at" timestamp with time zone,
	"policy_read_at" timestamp with time zone,
	"resolver_version" smallint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "influence_edge_evidence" (
	"edge_id" bigint NOT NULL,
	"evidence_span_id" bigint NOT NULL,
	CONSTRAINT "influence_edge_evidence_edge_id_evidence_span_id_pk" PRIMARY KEY("edge_id","evidence_span_id")
);
--> statement-breakpoint
CREATE TABLE "influence_edges" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"from_node_id" integer NOT NULL,
	"to_node_id" integer NOT NULL,
	"kind" "influence_edge_kind" NOT NULL,
	"person_role_id" integer,
	"ownership_id" integer,
	"rpt_id" bigint,
	"political_role_id" integer,
	"affidavit_interest_id" integer,
	"donation_id" integer,
	"policy_event_tag_id" integer,
	"confidence" real NOT NULL,
	"status" "influence_edge_status" DEFAULT 'pending' NOT NULL,
	"resolver_version" smallint NOT NULL,
	"input_hash" text NOT NULL,
	"valid_from" date,
	"valid_to" date,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "influence_edges_fact_ck" CHECK (num_nonnulls("influence_edges"."person_role_id", "influence_edges"."ownership_id", "influence_edges"."rpt_id", "influence_edges"."political_role_id", "influence_edges"."affidavit_interest_id", "influence_edges"."donation_id", "influence_edges"."policy_event_tag_id") <= 1),
	CONSTRAINT "influence_edges_pair_ck" CHECK ("influence_edges"."from_node_id" <> "influence_edges"."to_node_id"),
	CONSTRAINT "influence_edges_confidence_ck" CHECK ("influence_edges"."confidence" >= 0 and "influence_edges"."confidence" <= 1),
	CONSTRAINT "influence_edges_valid_ck" CHECK ("influence_edges"."valid_to" is null or "influence_edges"."valid_from" is null or "influence_edges"."valid_from" <= "influence_edges"."valid_to")
);
--> statement-breakpoint
CREATE TABLE "influence_event_edges" (
	"event_id" bigint NOT NULL,
	"edge_id" bigint NOT NULL,
	CONSTRAINT "influence_event_edges_event_id_edge_id_pk" PRIMARY KEY("event_id","edge_id")
);
--> statement-breakpoint
CREATE TABLE "influence_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"company_id" integer NOT NULL,
	"kind" "influence_event_kind" NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"summary" text NOT NULL,
	"rule_version" smallint NOT NULL,
	"input_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "influence_events_uq" UNIQUE("company_id","kind","input_hash")
);
--> statement-breakpoint
CREATE TABLE "influence_extractions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"document_revision_id" bigint NOT NULL,
	"company_id" integer,
	"family" "influence_family" NOT NULL,
	"version" smallint NOT NULL,
	"input_hash" text NOT NULL,
	"status" "extraction_status" DEFAULT 'running' NOT NULL,
	"rows" integer DEFAULT 0 NOT NULL,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "influence_extractions_uq" UNIQUE("document_revision_id","family","version","input_hash")
);
--> statement-breakpoint
CREATE TABLE "influence_reviews" (
	"id" serial PRIMARY KEY NOT NULL,
	"edge_id" bigint NOT NULL,
	"decision" "influence_decision" NOT NULL,
	"reviewer" text NOT NULL,
	"note" text,
	"edge_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ownership" (
	"id" serial PRIMARY KEY NOT NULL,
	"holder_node_id" integer NOT NULL,
	"target_node_id" integer NOT NULL,
	"pct" real,
	"shares" bigint,
	"as_of" date NOT NULL,
	"source" text NOT NULL,
	"document_revision_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ownership_uq" UNIQUE("holder_node_id","target_node_id","as_of","source"),
	CONSTRAINT "ownership_pct_ck" CHECK ("ownership"."pct" is null or ("ownership"."pct" >= 0 and "ownership"."pct" <= 100)),
	CONSTRAINT "ownership_pair_ck" CHECK ("ownership"."holder_node_id" <> "ownership"."target_node_id")
);
--> statement-breakpoint
CREATE TABLE "person_aliases" (
	"person_id" integer NOT NULL,
	"alias" text NOT NULL,
	"normalized_alias" text NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "person_aliases_person_id_normalized_alias_pk" PRIMARY KEY("person_id","normalized_alias")
);
--> statement-breakpoint
CREATE TABLE "person_identifiers" (
	"scheme" "person_identifier_scheme" NOT NULL,
	"value" text NOT NULL,
	"person_id" integer NOT NULL,
	"document_revision_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "person_identifiers_scheme_value_pk" PRIMARY KEY("scheme","value")
);
--> statement-breakpoint
CREATE TABLE "person_roles" (
	"id" serial PRIMARY KEY NOT NULL,
	"person_id" integer NOT NULL,
	"company_id" integer,
	"counterparty_id" integer,
	"role" "person_role_kind" NOT NULL,
	"category" text,
	"din_source" text,
	"from_date" date,
	"to_date" date,
	"document_revision_id" bigint,
	"evidence_span_id" bigint,
	"status" "influence_fact_status" DEFAULT 'current' NOT NULL,
	"dedupe_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "person_roles_target_ck" CHECK (num_nonnulls("person_roles"."company_id", "person_roles"."counterparty_id") = 1),
	CONSTRAINT "person_roles_dates_ck" CHECK ("person_roles"."to_date" is null or "person_roles"."from_date" is null or "person_roles"."from_date" <= "person_roles"."to_date")
);
--> statement-breakpoint
CREATE TABLE "persons" (
	"id" serial PRIMARY KEY NOT NULL,
	"din" text,
	"canonical_name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"gender" text,
	"birth_year" smallint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "persons_din_ck" CHECK ("persons"."din" is null or "persons"."din" ~ '^[0-9]{8}$'),
	CONSTRAINT "persons_birth_year_ck" CHECK ("persons"."birth_year" is null or "persons"."birth_year" between 1900 and 2100)
);
--> statement-breakpoint
CREATE TABLE "policy_event_tags" (
	"id" serial PRIMARY KEY NOT NULL,
	"policy_event_id" integer NOT NULL,
	"sector_key" text,
	"company_id" integer,
	"basis" "policy_tag_basis" NOT NULL,
	"evidence_span_id" bigint,
	"confidence" real NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "policy_event_tags_uq" UNIQUE NULLS NOT DISTINCT("policy_event_id","sector_key","company_id"),
	CONSTRAINT "policy_event_tags_target_ck" CHECK (num_nonnulls("policy_event_tags"."sector_key", "policy_event_tags"."company_id") = 1),
	CONSTRAINT "policy_event_tags_confidence_ck" CHECK ("policy_event_tags"."confidence" >= 0 and "policy_event_tags"."confidence" <= 1)
);
--> statement-breakpoint
CREATE TABLE "policy_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"source" "policy_event_source" NOT NULL,
	"external_id" text NOT NULL,
	"title" text NOT NULL,
	"ministry" text,
	"stage" text,
	"published_at" timestamp with time zone NOT NULL,
	"url" text NOT NULL,
	"document_revision_id" bigint,
	"input_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "policy_events_external_uq" UNIQUE("source","external_id")
);
--> statement-breakpoint
CREATE TABLE "policy_sectors" (
	"key" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"ministry_keys" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "political_donations" (
	"id" serial PRIMARY KEY NOT NULL,
	"purchase_row_id" integer NOT NULL,
	"redemption_row_id" integer NOT NULL,
	"counterparty_id" integer,
	"party" text NOT NULL,
	"amount" bigint NOT NULL,
	"matched_on" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "political_donations_pair_uq" UNIQUE("purchase_row_id","redemption_row_id"),
	CONSTRAINT "political_donations_amount_ck" CHECK ("political_donations"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "political_roles" (
	"id" serial PRIMARY KEY NOT NULL,
	"person_id" integer NOT NULL,
	"office" "political_office" NOT NULL,
	"party" text,
	"constituency" text,
	"state" text,
	"from_date" date,
	"to_date" date,
	"source" text NOT NULL,
	"document_revision_id" bigint,
	"status" "influence_fact_status" DEFAULT 'current' NOT NULL,
	"dedupe_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "related_party_transactions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"company_id" integer NOT NULL,
	"counterparty_id" integer,
	"counterparty_name" text NOT NULL,
	"relationship" text,
	"transaction_type" text,
	"value_cr" numeric(18, 2),
	"period_start" date,
	"period_end" date,
	"scope" text,
	"source" text NOT NULL,
	"document_revision_id" bigint,
	"evidence_span_id" bigint,
	"dedupe_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "related_party_transactions_value_ck" CHECK ("related_party_transactions"."value_cr" is null or "related_party_transactions"."value_cr" >= 0)
);
--> statement-breakpoint
ALTER TABLE "affidavit_interests" ADD CONSTRAINT "affidavit_interests_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affidavit_interests" ADD CONSTRAINT "affidavit_interests_target_node_id_graph_nodes_id_fk" FOREIGN KEY ("target_node_id") REFERENCES "public"."graph_nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affidavit_interests" ADD CONSTRAINT "affidavit_interests_document_revision_id_document_revisions_id_fk" FOREIGN KEY ("document_revision_id") REFERENCES "public"."document_revisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "affidavit_interests" ADD CONSTRAINT "affidavit_interests_evidence_span_id_evidence_spans_id_fk" FOREIGN KEY ("evidence_span_id") REFERENCES "public"."evidence_spans"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_policy_sectors" ADD CONSTRAINT "company_policy_sectors_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_policy_sectors" ADD CONSTRAINT "company_policy_sectors_sector_key_policy_sectors_key_fk" FOREIGN KEY ("sector_key") REFERENCES "public"."policy_sectors"("key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_policy_sectors" ADD CONSTRAINT "company_policy_sectors_evidence_span_id_evidence_spans_id_fk" FOREIGN KEY ("evidence_span_id") REFERENCES "public"."evidence_spans"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "electoral_bond_rows" ADD CONSTRAINT "electoral_bond_rows_counterparty_id_counterparties_id_fk" FOREIGN KEY ("counterparty_id") REFERENCES "public"."counterparties"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "electoral_bond_rows" ADD CONSTRAINT "electoral_bond_rows_document_revision_id_document_revisions_id_fk" FOREIGN KEY ("document_revision_id") REFERENCES "public"."document_revisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_nodes" ADD CONSTRAINT "graph_nodes_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_nodes" ADD CONSTRAINT "graph_nodes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_nodes" ADD CONSTRAINT "graph_nodes_counterparty_id_counterparties_id_fk" FOREIGN KEY ("counterparty_id") REFERENCES "public"."counterparties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_nodes" ADD CONSTRAINT "graph_nodes_sector_key_policy_sectors_key_fk" FOREIGN KEY ("sector_key") REFERENCES "public"."policy_sectors"("key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_nodes" ADD CONSTRAINT "graph_nodes_policy_event_id_policy_events_id_fk" FOREIGN KEY ("policy_event_id") REFERENCES "public"."policy_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "influence_coverage" ADD CONSTRAINT "influence_coverage_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "influence_edge_evidence" ADD CONSTRAINT "influence_edge_evidence_edge_id_influence_edges_id_fk" FOREIGN KEY ("edge_id") REFERENCES "public"."influence_edges"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "influence_edge_evidence" ADD CONSTRAINT "influence_edge_evidence_evidence_span_id_evidence_spans_id_fk" FOREIGN KEY ("evidence_span_id") REFERENCES "public"."evidence_spans"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "influence_edges" ADD CONSTRAINT "influence_edges_from_node_id_graph_nodes_id_fk" FOREIGN KEY ("from_node_id") REFERENCES "public"."graph_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "influence_edges" ADD CONSTRAINT "influence_edges_to_node_id_graph_nodes_id_fk" FOREIGN KEY ("to_node_id") REFERENCES "public"."graph_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "influence_edges" ADD CONSTRAINT "influence_edges_person_role_id_person_roles_id_fk" FOREIGN KEY ("person_role_id") REFERENCES "public"."person_roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "influence_edges" ADD CONSTRAINT "influence_edges_ownership_id_ownership_id_fk" FOREIGN KEY ("ownership_id") REFERENCES "public"."ownership"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "influence_edges" ADD CONSTRAINT "influence_edges_rpt_id_related_party_transactions_id_fk" FOREIGN KEY ("rpt_id") REFERENCES "public"."related_party_transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "influence_edges" ADD CONSTRAINT "influence_edges_political_role_id_political_roles_id_fk" FOREIGN KEY ("political_role_id") REFERENCES "public"."political_roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "influence_edges" ADD CONSTRAINT "influence_edges_affidavit_interest_id_affidavit_interests_id_fk" FOREIGN KEY ("affidavit_interest_id") REFERENCES "public"."affidavit_interests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "influence_edges" ADD CONSTRAINT "influence_edges_donation_id_political_donations_id_fk" FOREIGN KEY ("donation_id") REFERENCES "public"."political_donations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "influence_edges" ADD CONSTRAINT "influence_edges_policy_event_tag_id_policy_event_tags_id_fk" FOREIGN KEY ("policy_event_tag_id") REFERENCES "public"."policy_event_tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "influence_event_edges" ADD CONSTRAINT "influence_event_edges_event_id_influence_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."influence_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "influence_event_edges" ADD CONSTRAINT "influence_event_edges_edge_id_influence_edges_id_fk" FOREIGN KEY ("edge_id") REFERENCES "public"."influence_edges"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "influence_events" ADD CONSTRAINT "influence_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "influence_extractions" ADD CONSTRAINT "influence_extractions_document_revision_id_document_revisions_id_fk" FOREIGN KEY ("document_revision_id") REFERENCES "public"."document_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "influence_extractions" ADD CONSTRAINT "influence_extractions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "influence_reviews" ADD CONSTRAINT "influence_reviews_edge_id_influence_edges_id_fk" FOREIGN KEY ("edge_id") REFERENCES "public"."influence_edges"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ownership" ADD CONSTRAINT "ownership_holder_node_id_graph_nodes_id_fk" FOREIGN KEY ("holder_node_id") REFERENCES "public"."graph_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ownership" ADD CONSTRAINT "ownership_target_node_id_graph_nodes_id_fk" FOREIGN KEY ("target_node_id") REFERENCES "public"."graph_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ownership" ADD CONSTRAINT "ownership_document_revision_id_document_revisions_id_fk" FOREIGN KEY ("document_revision_id") REFERENCES "public"."document_revisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_aliases" ADD CONSTRAINT "person_aliases_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_identifiers" ADD CONSTRAINT "person_identifiers_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_identifiers" ADD CONSTRAINT "person_identifiers_document_revision_id_document_revisions_id_fk" FOREIGN KEY ("document_revision_id") REFERENCES "public"."document_revisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_roles" ADD CONSTRAINT "person_roles_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_roles" ADD CONSTRAINT "person_roles_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_roles" ADD CONSTRAINT "person_roles_counterparty_id_counterparties_id_fk" FOREIGN KEY ("counterparty_id") REFERENCES "public"."counterparties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_roles" ADD CONSTRAINT "person_roles_document_revision_id_document_revisions_id_fk" FOREIGN KEY ("document_revision_id") REFERENCES "public"."document_revisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_roles" ADD CONSTRAINT "person_roles_evidence_span_id_evidence_spans_id_fk" FOREIGN KEY ("evidence_span_id") REFERENCES "public"."evidence_spans"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_event_tags" ADD CONSTRAINT "policy_event_tags_policy_event_id_policy_events_id_fk" FOREIGN KEY ("policy_event_id") REFERENCES "public"."policy_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_event_tags" ADD CONSTRAINT "policy_event_tags_sector_key_policy_sectors_key_fk" FOREIGN KEY ("sector_key") REFERENCES "public"."policy_sectors"("key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_event_tags" ADD CONSTRAINT "policy_event_tags_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_event_tags" ADD CONSTRAINT "policy_event_tags_evidence_span_id_evidence_spans_id_fk" FOREIGN KEY ("evidence_span_id") REFERENCES "public"."evidence_spans"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_events" ADD CONSTRAINT "policy_events_document_revision_id_document_revisions_id_fk" FOREIGN KEY ("document_revision_id") REFERENCES "public"."document_revisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "political_donations" ADD CONSTRAINT "political_donations_purchase_row_id_electoral_bond_rows_id_fk" FOREIGN KEY ("purchase_row_id") REFERENCES "public"."electoral_bond_rows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "political_donations" ADD CONSTRAINT "political_donations_redemption_row_id_electoral_bond_rows_id_fk" FOREIGN KEY ("redemption_row_id") REFERENCES "public"."electoral_bond_rows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "political_donations" ADD CONSTRAINT "political_donations_counterparty_id_counterparties_id_fk" FOREIGN KEY ("counterparty_id") REFERENCES "public"."counterparties"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "political_roles" ADD CONSTRAINT "political_roles_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "political_roles" ADD CONSTRAINT "political_roles_document_revision_id_document_revisions_id_fk" FOREIGN KEY ("document_revision_id") REFERENCES "public"."document_revisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "related_party_transactions" ADD CONSTRAINT "related_party_transactions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "related_party_transactions" ADD CONSTRAINT "related_party_transactions_counterparty_id_counterparties_id_fk" FOREIGN KEY ("counterparty_id") REFERENCES "public"."counterparties"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "related_party_transactions" ADD CONSTRAINT "related_party_transactions_document_revision_id_document_revisions_id_fk" FOREIGN KEY ("document_revision_id") REFERENCES "public"."document_revisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "related_party_transactions" ADD CONSTRAINT "related_party_transactions_evidence_span_id_evidence_spans_id_fk" FOREIGN KEY ("evidence_span_id") REFERENCES "public"."evidence_spans"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "affidavit_interests_dedupe_uq" ON "affidavit_interests" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "affidavit_interests_person_idx" ON "affidavit_interests" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "affidavit_interests_target_idx" ON "affidavit_interests" USING btree ("target_node_id");--> statement-breakpoint
CREATE INDEX "company_policy_sectors_sector_idx" ON "company_policy_sectors" USING btree ("sector_key");--> statement-breakpoint
CREATE INDEX "electoral_bond_rows_counterparty_idx" ON "electoral_bond_rows" USING btree ("counterparty_id");--> statement-breakpoint
CREATE UNIQUE INDEX "graph_nodes_person_uq" ON "graph_nodes" USING btree ("person_id");--> statement-breakpoint
CREATE UNIQUE INDEX "graph_nodes_company_uq" ON "graph_nodes" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "graph_nodes_counterparty_uq" ON "graph_nodes" USING btree ("counterparty_id");--> statement-breakpoint
CREATE UNIQUE INDEX "graph_nodes_sector_uq" ON "graph_nodes" USING btree ("sector_key");--> statement-breakpoint
CREATE UNIQUE INDEX "graph_nodes_policy_event_uq" ON "graph_nodes" USING btree ("policy_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "graph_nodes_party_uq" ON "graph_nodes" USING btree ("party_name");--> statement-breakpoint
CREATE INDEX "influence_edge_evidence_span_idx" ON "influence_edge_evidence" USING btree ("evidence_span_id");--> statement-breakpoint
CREATE UNIQUE INDEX "influence_edges_confirmed_uq" ON "influence_edges" USING btree ("from_node_id","to_node_id","kind") WHERE "influence_edges"."status" = 'confirmed';--> statement-breakpoint
CREATE UNIQUE INDEX "influence_edges_pending_uq" ON "influence_edges" USING btree ("from_node_id","to_node_id","kind") WHERE "influence_edges"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "influence_edges_from_confirmed_idx" ON "influence_edges" USING btree ("from_node_id") WHERE "influence_edges"."status" = 'confirmed';--> statement-breakpoint
CREATE INDEX "influence_edges_to_confirmed_idx" ON "influence_edges" USING btree ("to_node_id") WHERE "influence_edges"."status" = 'confirmed';--> statement-breakpoint
CREATE INDEX "influence_edges_review_idx" ON "influence_edges" USING btree ("status","confidence","created_at");--> statement-breakpoint
CREATE INDEX "influence_event_edges_edge_idx" ON "influence_event_edges" USING btree ("edge_id");--> statement-breakpoint
CREATE INDEX "influence_events_company_idx" ON "influence_events" USING btree ("company_id","occurred_at");--> statement-breakpoint
CREATE INDEX "influence_extractions_company_idx" ON "influence_extractions" USING btree ("company_id","family");--> statement-breakpoint
CREATE INDEX "influence_reviews_edge_idx" ON "influence_reviews" USING btree ("edge_id","created_at");--> statement-breakpoint
CREATE INDEX "ownership_target_idx" ON "ownership" USING btree ("target_node_id","as_of");--> statement-breakpoint
CREATE INDEX "person_aliases_norm_idx" ON "person_aliases" USING btree ("normalized_alias");--> statement-breakpoint
CREATE INDEX "person_identifiers_person_idx" ON "person_identifiers" USING btree ("person_id");--> statement-breakpoint
CREATE UNIQUE INDEX "person_roles_dedupe_uq" ON "person_roles" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "person_roles_person_idx" ON "person_roles" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "person_roles_company_idx" ON "person_roles" USING btree ("company_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "persons_din_uq" ON "persons" USING btree ("din") WHERE "persons"."din" is not null;--> statement-breakpoint
CREATE INDEX "persons_normalized_idx" ON "persons" USING btree ("normalized_name");--> statement-breakpoint
CREATE INDEX "policy_event_tags_sector_idx" ON "policy_event_tags" USING btree ("sector_key");--> statement-breakpoint
CREATE INDEX "policy_event_tags_company_idx" ON "policy_event_tags" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "policy_events_published_idx" ON "policy_events" USING btree ("published_at");--> statement-breakpoint
CREATE UNIQUE INDEX "political_donations_purchase_uq" ON "political_donations" USING btree ("purchase_row_id");--> statement-breakpoint
CREATE UNIQUE INDEX "political_donations_redemption_uq" ON "political_donations" USING btree ("redemption_row_id");--> statement-breakpoint
CREATE INDEX "political_donations_counterparty_idx" ON "political_donations" USING btree ("counterparty_id");--> statement-breakpoint
CREATE UNIQUE INDEX "political_roles_dedupe_uq" ON "political_roles" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "political_roles_person_idx" ON "political_roles" USING btree ("person_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "related_party_transactions_dedupe_uq" ON "related_party_transactions" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "related_party_transactions_company_idx" ON "related_party_transactions" USING btree ("company_id","period_end");--> statement-breakpoint
CREATE INDEX "related_party_transactions_counterparty_idx" ON "related_party_transactions" USING btree ("counterparty_id");--> statement-breakpoint
CREATE VIEW graph_node_labels AS
SELECT
  n.id AS node_id,
  n.kind,
  coalesce(p.canonical_name, c.name, cp.canonical_name, ps.label, pe.title, n.party_name) AS label,
  coalesce(n.company_id, cp.company_id) AS company_id,
  coalesce(c.nse_symbol, lc.nse_symbol) AS symbol,
  n.person_id,
  p.din,
  n.counterparty_id,
  cp.kind AS counterparty_kind
FROM graph_nodes n
LEFT JOIN persons p ON p.id = n.person_id
LEFT JOIN companies c ON c.id = n.company_id
LEFT JOIN counterparties cp ON cp.id = n.counterparty_id
LEFT JOIN companies lc ON lc.id = cp.company_id
LEFT JOIN policy_sectors ps ON ps.key = n.sector_key
LEFT JOIN policy_events pe ON pe.id = n.policy_event_id;--> statement-breakpoint
CREATE VIEW influence_edges_confirmed AS
SELECT
  e.id,
  e.kind,
  e.confidence,
  e.version,
  e.resolver_version,
  e.valid_from,
  e.valid_to,
  e.created_at,
  e.updated_at,
  e.person_role_id,
  e.ownership_id,
  e.rpt_id,
  e.political_role_id,
  e.affidavit_interest_id,
  e.donation_id,
  e.policy_event_tag_id,
  e.from_node_id,
  f.kind AS from_kind,
  f.label AS from_label,
  f.company_id AS from_company_id,
  f.symbol AS from_symbol,
  f.person_id AS from_person_id,
  f.din AS from_din,
  f.counterparty_kind AS from_counterparty_kind,
  e.to_node_id,
  t.kind AS to_kind,
  t.label AS to_label,
  t.company_id AS to_company_id,
  t.symbol AS to_symbol,
  t.person_id AS to_person_id,
  t.din AS to_din,
  t.counterparty_kind AS to_counterparty_kind
FROM influence_edges e
JOIN graph_node_labels f ON f.node_id = e.from_node_id
JOIN graph_node_labels t ON t.node_id = e.to_node_id
WHERE e.status = 'confirmed';--> statement-breakpoint
CREATE OR REPLACE FUNCTION review_influence_edge(
  p_edge_id bigint,
  p_decision text,
  p_reviewer text,
  p_note text,
  p_expected_version integer
) RETURNS TABLE (review_id integer, status text, version integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
DECLARE
  v_edge influence_edges%ROWTYPE;
  v_status influence_edge_status;
  v_version integer;
  v_review_id integer;
BEGIN
  IF p_reviewer IS NULL OR length(trim(p_reviewer)) = 0 THEN
    RAISE EXCEPTION 'reviewer required' USING ERRCODE = '22023';
  END IF;
  IF p_decision IS NULL OR p_decision NOT IN ('confirm', 'reject') THEN
    RAISE EXCEPTION 'invalid decision %', p_decision USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_edge FROM influence_edges WHERE id = p_edge_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'influence edge % not found', p_edge_id USING ERRCODE = 'P0002';
  END IF;
  IF v_edge.status = 'superseded' THEN
    RAISE EXCEPTION 'influence edge % is superseded', p_edge_id USING ERRCODE = '22023';
  END IF;
  IF p_expected_version IS NULL OR v_edge.version <> p_expected_version THEN
    RAISE EXCEPTION 'influence edge % version mismatch: expected %, found %', p_edge_id, p_expected_version, v_edge.version USING ERRCODE = '40001';
  END IF;
  IF p_decision = 'confirm' THEN
    v_status := 'confirmed';
    UPDATE influence_edges e SET status = 'superseded', version = e.version + 1, updated_at = now()
    WHERE e.from_node_id = v_edge.from_node_id
      AND e.to_node_id = v_edge.to_node_id
      AND e.kind = v_edge.kind
      AND e.status = 'confirmed'
      AND e.id <> v_edge.id;
  ELSE
    v_status := 'rejected';
  END IF;
  UPDATE influence_edges e SET status = v_status, version = e.version + 1, updated_at = now()
  WHERE e.id = p_edge_id
  RETURNING e.version INTO v_version;
  INSERT INTO influence_reviews (edge_id, decision, reviewer, note, edge_version)
  VALUES (p_edge_id, p_decision::influence_decision, p_reviewer, p_note, p_expected_version)
  RETURNING id INTO v_review_id;
  RETURN QUERY SELECT v_review_id, v_status::text, v_version;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION review_influence_edge(bigint, text, text, text, integer) FROM PUBLIC;
