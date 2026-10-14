CREATE TYPE "public"."alias_source" AS ENUM('registry', 'curated', 'reviewer', 'extracted');--> statement-breakpoint
CREATE TYPE "public"."counterparty_kind" AS ENUM('listed', 'private', 'government', 'foreign', 'group');--> statement-breakpoint
CREATE TYPE "public"."extraction_status" AS ENUM('running', 'succeeded', 'failed', 'deferred');--> statement-breakpoint
CREATE TYPE "public"."financial_metric" AS ENUM('revenue', 'cogs', 'purchases', 'capex', 'sga', 'rnd', 'related_party_sales', 'related_party_purchases');--> statement-breakpoint
CREATE TYPE "public"."observation_status" AS ENUM('pending', 'auto', 'confirmed', 'rejected', 'blocked', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('awarded', 'pending', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."relationship_family" AS ENUM('legacy', 'annual_report', 'concall', 'order_filing', 'announcement_metadata', 'rating_rationale', 'presentation', 'screener', 'manual');--> statement-breakpoint
CREATE TYPE "public"."relationship_status" AS ENUM('active', 'expired', 'superseded', 'blocked', 'legacy');--> statement-breakpoint
CREATE TYPE "public"."review_decision" AS ENUM('confirm', 'reject', 'block');--> statement-breakpoint
CREATE TYPE "public"."value_basis" AS ENUM('revenue_share', 'purchase_share', 'annual_flow', 'contract_total', 'unknown');--> statement-breakpoint
CREATE TABLE "company_graph_state" (
	"company_id" integer PRIMARY KEY NOT NULL,
	"graph_revision" integer DEFAULT 0 NOT NULL,
	"extractor_version" smallint DEFAULT 0 NOT NULL,
	"documents_available" integer DEFAULT 0 NOT NULL,
	"documents_read" integer DEFAULT 0 NOT NULL,
	"observations" integer DEFAULT 0 NOT NULL,
	"edges" integer DEFAULT 0 NOT NULL,
	"last_disclosed_at" date,
	"rebuilt_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "company_group_memberships" (
	"company_id" integer NOT NULL,
	"group_key" text NOT NULL,
	"source" text NOT NULL,
	"valid_from" date,
	"valid_to" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_group_memberships_company_id_group_key_pk" PRIMARY KEY("company_id","group_key")
);
--> statement-breakpoint
CREATE TABLE "counterparties" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" "counterparty_kind" NOT NULL,
	"canonical_name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"company_id" integer,
	"country" text,
	"sector" text,
	"group_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "counterparty_aliases" (
	"counterparty_id" integer NOT NULL,
	"alias" text NOT NULL,
	"normalized_alias" text NOT NULL,
	"source" "alias_source" NOT NULL,
	"approved" boolean DEFAULT false NOT NULL,
	"exact_case" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "counterparty_aliases_counterparty_id_normalized_alias_pk" PRIMARY KEY("counterparty_id","normalized_alias")
);
--> statement-breakpoint
CREATE TABLE "counterparty_identifiers" (
	"counterparty_id" integer NOT NULL,
	"scheme" text NOT NULL,
	"value" text NOT NULL,
	CONSTRAINT "counterparty_identifiers_scheme_value_pk" PRIMARY KEY("scheme","value")
);
--> statement-breakpoint
CREATE TABLE "relationship_blocks" (
	"id" serial PRIMARY KEY NOT NULL,
	"supplier_counterparty_id" integer NOT NULL,
	"customer_counterparty_id" integer NOT NULL,
	"reason" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relationship_extractions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"document_revision_id" bigint NOT NULL,
	"company_id" integer NOT NULL,
	"extractor_family" "relationship_family" NOT NULL,
	"extractor_version" smallint NOT NULL,
	"inputs_hash" text NOT NULL,
	"status" "extraction_status" DEFAULT 'running' NOT NULL,
	"observations" integer DEFAULT 0 NOT NULL,
	"dropped" integer DEFAULT 0 NOT NULL,
	"tokens" integer DEFAULT 0 NOT NULL,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "relationship_financial_facts" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" integer NOT NULL,
	"period_end" date NOT NULL,
	"period_type" "period_type" NOT NULL,
	"metric" "financial_metric" NOT NULL,
	"value_cr" numeric(18, 2) NOT NULL,
	"source_revision_id" bigint,
	"parser_version" smallint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relationship_observation_evidence" (
	"observation_id" bigint NOT NULL,
	"evidence_span_id" bigint NOT NULL,
	CONSTRAINT "relationship_observation_evidence_observation_id_evidence_span_id_pk" PRIMARY KEY("observation_id","evidence_span_id")
);
--> statement-breakpoint
CREATE TABLE "relationship_observations" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"extraction_id" bigint NOT NULL,
	"focal_company_id" integer NOT NULL,
	"supplier_counterparty_id" integer NOT NULL,
	"customer_counterparty_id" integer NOT NULL,
	"disclosed_by" "disclosed_by" NOT NULL,
	"disclosure_kind" "disclosure_kind" NOT NULL,
	"cost_bucket" "cost_bucket" DEFAULT 'UNKNOWN' NOT NULL,
	"value_basis" "value_basis" DEFAULT 'unknown' NOT NULL,
	"cue_class" text NOT NULL,
	"pct" real,
	"value_cr" numeric(18, 2),
	"currency" text,
	"period_start" date,
	"period_end" date,
	"fiscal_year" smallint,
	"order_status" "order_status",
	"claim" text NOT NULL,
	"confidence" real NOT NULL,
	"status" "observation_status" DEFAULT 'pending' NOT NULL,
	"new_counterparty" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "relationship_observations_pct_ck" CHECK ("relationship_observations"."pct" is null or ("relationship_observations"."pct" > 0 and "relationship_observations"."pct" <= 100)),
	CONSTRAINT "relationship_observations_value_ck" CHECK ("relationship_observations"."value_cr" is null or "relationship_observations"."value_cr" >= 0),
	CONSTRAINT "relationship_observations_pair_ck" CHECK ("relationship_observations"."supplier_counterparty_id" <> "relationship_observations"."customer_counterparty_id")
);
--> statement-breakpoint
CREATE TABLE "relationship_priors" (
	"id" serial PRIMARY KEY NOT NULL,
	"supplier_sector" text NOT NULL,
	"cost_bucket" "cost_bucket" NOT NULL,
	"cue_class" text NOT NULL,
	"disclosures" integer NOT NULL,
	"suppliers" integer NOT NULL,
	"share_p25" real NOT NULL,
	"share_p50" real NOT NULL,
	"share_p75" real NOT NULL,
	"model_version" smallint NOT NULL,
	"built_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relationship_reviews" (
	"id" serial PRIMARY KEY NOT NULL,
	"observation_id" bigint NOT NULL,
	"relationship_id" integer,
	"decision" "review_decision" NOT NULL,
	"reviewer" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relationship_sources" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" integer NOT NULL,
	"family" "relationship_family" NOT NULL,
	"document_id" integer NOT NULL,
	"label" text,
	"published_at" date,
	"read_revision_id" bigint,
	"read_extractor_version" smallint,
	"last_read_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "insights_key_uq";--> statement-breakpoint
DROP INDEX "relationship_estimates_uq";--> statement-breakpoint
ALTER TABLE "relationship_estimates" ADD COLUMN "value_basis" "value_basis" DEFAULT 'annual_flow' NOT NULL;--> statement-breakpoint
ALTER TABLE "relationship_estimates" ADD COLUMN "period_start" date;--> statement-breakpoint
ALTER TABLE "relationship_estimates" ADD COLUMN "period_end" date;--> statement-breakpoint
ALTER TABLE "relationship_estimates" ADD COLUMN "inputs_hash" text;--> statement-breakpoint
ALTER TABLE "relationships" ADD COLUMN "supplier_counterparty_id" integer;--> statement-breakpoint
ALTER TABLE "relationships" ADD COLUMN "customer_counterparty_id" integer;--> statement-breakpoint
ALTER TABLE "relationships" ADD COLUMN "edge_key" text;--> statement-breakpoint
ALTER TABLE "relationships" ADD COLUMN "value_basis" "value_basis" DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "relationships" ADD COLUMN "extractor_family" "relationship_family" DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "relationships" ADD COLUMN "extractor_version" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "relationships" ADD COLUMN "graph_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "relationships" ADD COLUMN "status" "relationship_status" DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "relationships" ADD COLUMN "superseded_by_id" integer;--> statement-breakpoint
ALTER TABLE "relationships" ADD COLUMN "last_disclosed_at" date;--> statement-breakpoint
ALTER TABLE "relationships" ADD COLUMN "observation_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "company_graph_state" ADD CONSTRAINT "company_graph_state_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_group_memberships" ADD CONSTRAINT "company_group_memberships_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "counterparties" ADD CONSTRAINT "counterparties_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "counterparty_aliases" ADD CONSTRAINT "counterparty_aliases_counterparty_id_counterparties_id_fk" FOREIGN KEY ("counterparty_id") REFERENCES "public"."counterparties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "counterparty_identifiers" ADD CONSTRAINT "counterparty_identifiers_counterparty_id_counterparties_id_fk" FOREIGN KEY ("counterparty_id") REFERENCES "public"."counterparties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationship_blocks" ADD CONSTRAINT "relationship_blocks_supplier_counterparty_id_counterparties_id_fk" FOREIGN KEY ("supplier_counterparty_id") REFERENCES "public"."counterparties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationship_blocks" ADD CONSTRAINT "relationship_blocks_customer_counterparty_id_counterparties_id_fk" FOREIGN KEY ("customer_counterparty_id") REFERENCES "public"."counterparties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationship_extractions" ADD CONSTRAINT "relationship_extractions_document_revision_id_document_revisions_id_fk" FOREIGN KEY ("document_revision_id") REFERENCES "public"."document_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationship_extractions" ADD CONSTRAINT "relationship_extractions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationship_financial_facts" ADD CONSTRAINT "relationship_financial_facts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationship_financial_facts" ADD CONSTRAINT "relationship_financial_facts_source_revision_id_document_revisions_id_fk" FOREIGN KEY ("source_revision_id") REFERENCES "public"."document_revisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationship_observation_evidence" ADD CONSTRAINT "relationship_observation_evidence_observation_id_relationship_observations_id_fk" FOREIGN KEY ("observation_id") REFERENCES "public"."relationship_observations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationship_observation_evidence" ADD CONSTRAINT "relationship_observation_evidence_evidence_span_id_evidence_spans_id_fk" FOREIGN KEY ("evidence_span_id") REFERENCES "public"."evidence_spans"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationship_observations" ADD CONSTRAINT "relationship_observations_extraction_id_relationship_extractions_id_fk" FOREIGN KEY ("extraction_id") REFERENCES "public"."relationship_extractions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationship_observations" ADD CONSTRAINT "relationship_observations_focal_company_id_companies_id_fk" FOREIGN KEY ("focal_company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationship_observations" ADD CONSTRAINT "relationship_observations_supplier_counterparty_id_counterparties_id_fk" FOREIGN KEY ("supplier_counterparty_id") REFERENCES "public"."counterparties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationship_observations" ADD CONSTRAINT "relationship_observations_customer_counterparty_id_counterparties_id_fk" FOREIGN KEY ("customer_counterparty_id") REFERENCES "public"."counterparties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationship_reviews" ADD CONSTRAINT "relationship_reviews_observation_id_relationship_observations_id_fk" FOREIGN KEY ("observation_id") REFERENCES "public"."relationship_observations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationship_reviews" ADD CONSTRAINT "relationship_reviews_relationship_id_relationships_id_fk" FOREIGN KEY ("relationship_id") REFERENCES "public"."relationships"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationship_sources" ADD CONSTRAINT "relationship_sources_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationship_sources" ADD CONSTRAINT "relationship_sources_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationship_sources" ADD CONSTRAINT "relationship_sources_read_revision_id_document_revisions_id_fk" FOREIGN KEY ("read_revision_id") REFERENCES "public"."document_revisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "company_group_memberships_group_idx" ON "company_group_memberships" USING btree ("group_key");--> statement-breakpoint
CREATE UNIQUE INDEX "counterparties_normalized_uq" ON "counterparties" USING btree ("normalized_name");--> statement-breakpoint
CREATE UNIQUE INDEX "counterparties_company_uq" ON "counterparties" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "counterparties_group_idx" ON "counterparties" USING btree ("group_key");--> statement-breakpoint
CREATE INDEX "counterparty_aliases_norm_idx" ON "counterparty_aliases" USING btree ("normalized_alias");--> statement-breakpoint
CREATE INDEX "counterparty_identifiers_cp_idx" ON "counterparty_identifiers" USING btree ("counterparty_id");--> statement-breakpoint
CREATE UNIQUE INDEX "relationship_blocks_pair_uq" ON "relationship_blocks" USING btree ("supplier_counterparty_id","customer_counterparty_id");--> statement-breakpoint
CREATE UNIQUE INDEX "relationship_extractions_uq" ON "relationship_extractions" USING btree ("document_revision_id","extractor_family","extractor_version","inputs_hash");--> statement-breakpoint
CREATE INDEX "relationship_extractions_company_idx" ON "relationship_extractions" USING btree ("company_id","extractor_family");--> statement-breakpoint
CREATE UNIQUE INDEX "relationship_financial_facts_uq" ON "relationship_financial_facts" USING btree ("company_id","period_end","period_type","metric");--> statement-breakpoint
CREATE INDEX "relationship_observation_evidence_span_idx" ON "relationship_observation_evidence" USING btree ("evidence_span_id");--> statement-breakpoint
CREATE INDEX "relationship_observations_extraction_idx" ON "relationship_observations" USING btree ("extraction_id");--> statement-breakpoint
CREATE INDEX "relationship_observations_pair_idx" ON "relationship_observations" USING btree ("supplier_counterparty_id","customer_counterparty_id","status");--> statement-breakpoint
CREATE INDEX "relationship_observations_review_idx" ON "relationship_observations" USING btree ("status","confidence","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "relationship_priors_uq" ON "relationship_priors" USING btree ("supplier_sector","cost_bucket","cue_class","model_version");--> statement-breakpoint
CREATE INDEX "relationship_reviews_observation_idx" ON "relationship_reviews" USING btree ("observation_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "relationship_sources_uq" ON "relationship_sources" USING btree ("company_id","family","document_id");--> statement-breakpoint
CREATE INDEX "relationship_sources_pending_idx" ON "relationship_sources" USING btree ("family","last_read_at");--> statement-breakpoint
ALTER TABLE "relationships" ADD CONSTRAINT "relationships_supplier_counterparty_id_counterparties_id_fk" FOREIGN KEY ("supplier_counterparty_id") REFERENCES "public"."counterparties"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationships" ADD CONSTRAINT "relationships_customer_counterparty_id_counterparties_id_fk" FOREIGN KEY ("customer_counterparty_id") REFERENCES "public"."counterparties"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "relationships_status_idx" ON "relationships" USING btree ("status","valid_to");--> statement-breakpoint
CREATE UNIQUE INDEX "relationships_edge_key_uq" ON "relationships" USING btree ("edge_key");--> statement-breakpoint
CREATE UNIQUE INDEX "relationship_estimates_uq" ON "relationship_estimates" USING btree ("relationship_id","as_of","model_version","value_basis");--> statement-breakpoint
ALTER TABLE "insights" ADD CONSTRAINT "insights_key_uq" UNIQUE NULLS NOT DISTINCT("company_id","kind","subject_id","model_version","input_hash");--> statement-breakpoint
ALTER TABLE "relationship_estimates" ADD CONSTRAINT "relationship_estimates_nonneg_ck" CHECK (coalesce("relationship_estimates"."value_cr", 0) >= 0 and coalesce("relationship_estimates"."value_low_cr", 0) >= 0 and coalesce("relationship_estimates"."value_high_cr", 0) >= 0);--> statement-breakpoint
ALTER TABLE "relationship_estimates" ADD CONSTRAINT "relationship_estimates_order_ck" CHECK (("relationship_estimates"."value_low_cr" is null or "relationship_estimates"."value_cr" is null or "relationship_estimates"."value_low_cr" <= "relationship_estimates"."value_cr")
        and ("relationship_estimates"."value_high_cr" is null or "relationship_estimates"."value_cr" is null or "relationship_estimates"."value_cr" <= "relationship_estimates"."value_high_cr"));--> statement-breakpoint
ALTER TABLE "market_symbols" ADD CONSTRAINT "market_symbols_source_document_revision_id_fk" FOREIGN KEY ("source_document_revision_id") REFERENCES "public"."document_revisions"("id") ON DELETE set null NOT VALID;--> statement-breakpoint
ALTER TABLE "price_gaps" ADD CONSTRAINT "price_gaps_evidence_revision_id_fk" FOREIGN KEY ("evidence_revision_id") REFERENCES "public"."document_revisions"("id") ON DELETE set null NOT VALID;--> statement-breakpoint
ALTER TABLE "corporate_actions" ADD CONSTRAINT "corporate_actions_source_revision_id_fk" FOREIGN KEY ("source_revision_id") REFERENCES "public"."document_revisions"("id") ON DELETE set null NOT VALID;--> statement-breakpoint
ALTER TABLE "market_symbols" VALIDATE CONSTRAINT "market_symbols_source_document_revision_id_fk";--> statement-breakpoint
ALTER TABLE "price_gaps" VALIDATE CONSTRAINT "price_gaps_evidence_revision_id_fk";--> statement-breakpoint
ALTER TABLE "corporate_actions" VALIDATE CONSTRAINT "corporate_actions_source_revision_id_fk";--> statement-breakpoint
ALTER TABLE "relationships" ADD CONSTRAINT "relationships_superseded_by_id_fk" FOREIGN KEY ("superseded_by_id") REFERENCES "public"."relationships"("id") ON DELETE set null;--> statement-breakpoint
UPDATE "relationships" SET "status" = 'legacy', "extractor_family" = 'legacy', "extractor_version" = 0 WHERE "edge_key" IS NULL;--> statement-breakpoint
CREATE OR REPLACE FUNCTION review_relationship(
  p_observation_id bigint,
  p_decision review_decision,
  p_reviewer text,
  p_note text DEFAULT NULL
) RETURNS TABLE (review_id integer, observation_status observation_status, relationship_id integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_obs relationship_observations%ROWTYPE;
  v_rel_id integer;
  v_review_id integer;
  v_status observation_status;
BEGIN
  IF p_reviewer IS NULL OR length(trim(p_reviewer)) = 0 THEN
    RAISE EXCEPTION 'reviewer required' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_obs FROM relationship_observations WHERE id = p_observation_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'observation % not found', p_observation_id USING ERRCODE = 'P0002';
  END IF;
  SELECT r.id INTO v_rel_id FROM relationships r
  WHERE r.supplier_counterparty_id = v_obs.supplier_counterparty_id
    AND r.customer_counterparty_id = v_obs.customer_counterparty_id
    AND r.cost_bucket = v_obs.cost_bucket
    AND r.status IN ('active', 'expired')
  ORDER BY r.graph_revision DESC LIMIT 1;
  IF p_decision = 'confirm' THEN
    v_status := 'confirmed';
  ELSIF p_decision = 'reject' THEN
    v_status := 'rejected';
  ELSE
    v_status := 'blocked';
    INSERT INTO relationship_blocks (supplier_counterparty_id, customer_counterparty_id, reason, created_by)
    VALUES (v_obs.supplier_counterparty_id, v_obs.customer_counterparty_id, coalesce(p_note, 'reviewer block'), p_reviewer)
    ON CONFLICT (supplier_counterparty_id, customer_counterparty_id) DO NOTHING;
    UPDATE relationship_observations SET status = 'blocked'
    WHERE supplier_counterparty_id = v_obs.supplier_counterparty_id
      AND customer_counterparty_id = v_obs.customer_counterparty_id
      AND status IN ('pending', 'auto', 'confirmed');
    UPDATE relationships SET status = 'blocked', updated_at = now()
    WHERE supplier_counterparty_id = v_obs.supplier_counterparty_id
      AND customer_counterparty_id = v_obs.customer_counterparty_id
      AND status IN ('active', 'expired');
  END IF;
  UPDATE relationship_observations SET status = v_status WHERE id = p_observation_id;
  IF p_decision = 'reject' AND v_rel_id IS NOT NULL THEN
    UPDATE relationships r SET observation_count = greatest(0, r.observation_count - 1), updated_at = now()
    WHERE r.id = v_rel_id;
    UPDATE relationships r SET status = 'superseded', updated_at = now()
    WHERE r.id = v_rel_id AND r.observation_count = 0;
  END IF;
  INSERT INTO relationship_reviews (observation_id, relationship_id, decision, reviewer, note)
  VALUES (p_observation_id, v_rel_id, p_decision, p_reviewer, p_note)
  RETURNING id INTO v_review_id;
  RETURN QUERY SELECT v_review_id, v_status, v_rel_id;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION review_relationship(bigint, review_decision, text, text) FROM PUBLIC;
