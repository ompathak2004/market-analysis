CREATE TYPE "public"."analyst_action" AS ENUM('initiate', 'maintain', 'upgrade', 'downgrade', 'raise_target', 'lower_target', 'reiterate', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."cost_bucket" AS ENUM('COGS', 'CAPEX', 'SGA', 'RND', 'UNKNOWN');--> statement-breakpoint
CREATE TYPE "public"."disclosed_by" AS ENUM('supplier', 'customer', 'third_party');--> statement-breakpoint
CREATE TYPE "public"."disclosure_kind" AS ENUM('major_customer', 'related_party', 'segment', 'contract', 'press', 'manual');--> statement-breakpoint
CREATE TYPE "public"."document_status" AS ENUM('fetched', 'parsed', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."estimate_method" AS ENUM('disclosed', 'derived', 'estimated');--> statement-breakpoint
CREATE TYPE "public"."ingest_status" AS ENUM('running', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."period_type" AS ENUM('annual', 'quarterly', 'ttm');--> statement-breakpoint
CREATE TABLE "analyst_calls" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" integer NOT NULL,
	"broker" text NOT NULL,
	"published_at" date NOT NULL,
	"action" "analyst_action" DEFAULT 'unknown' NOT NULL,
	"rating" text NOT NULL,
	"prior_rating" text,
	"target_price" real,
	"prior_target_price" real,
	"price_at_call" real,
	"report_url" text,
	"source" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"source_document_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "announcements" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" integer NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	"subject" text NOT NULL,
	"category" text,
	"details" text,
	"attachment_url" text,
	"dedupe_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "companies" (
	"id" serial PRIMARY KEY NOT NULL,
	"nse_symbol" text,
	"bse_code" text,
	"isin" text,
	"name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"sector" text,
	"industry" text,
	"screener_slug" text,
	"yahoo_symbol" text,
	"market_cap_cr" numeric(18, 2),
	"listed" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "company_aliases" (
	"company_id" integer NOT NULL,
	"alias" text NOT NULL,
	CONSTRAINT "company_aliases_company_id_alias_pk" PRIMARY KEY("company_id","alias")
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" serial PRIMARY KEY NOT NULL,
	"url" text NOT NULL,
	"source" text NOT NULL,
	"company_id" integer,
	"sha256" text NOT NULL,
	"content_type" text,
	"etag" text,
	"last_modified" text,
	"byte_size" integer NOT NULL,
	"content" text NOT NULL,
	"status" "document_status" DEFAULT 'fetched' NOT NULL,
	"parser_version" smallint,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"parsed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "fundamentals" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" integer NOT NULL,
	"period_end" date NOT NULL,
	"period_type" "period_type" NOT NULL,
	"revenue" numeric(18, 2),
	"cogs" numeric(18, 2),
	"sga" numeric(18, 2),
	"rnd" numeric(18, 2),
	"capex" numeric(18, 2),
	"operating_profit" numeric(18, 2),
	"interest_expense" numeric(18, 2),
	"pretax_income" numeric(18, 2),
	"net_income" numeric(18, 2),
	"total_assets" numeric(18, 2),
	"total_equity" numeric(18, 2),
	"total_debt" numeric(18, 2),
	"current_assets" numeric(18, 2),
	"current_liabilities" numeric(18, 2),
	"retained_earnings" numeric(18, 2),
	"cash_from_ops" numeric(18, 2),
	"source_document_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "index_constituents" (
	"index_id" integer NOT NULL,
	"company_id" integer NOT NULL,
	"weight" real,
	CONSTRAINT "index_constituents_index_id_company_id_pk" PRIMARY KEY("index_id","company_id")
);
--> statement-breakpoint
CREATE TABLE "indices" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"yahoo_symbol" text,
	CONSTRAINT "indices_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "ingest_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"status" "ingest_status" DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "prices_daily" (
	"company_id" integer NOT NULL,
	"date" date NOT NULL,
	"open" real,
	"high" real,
	"low" real,
	"close" real NOT NULL,
	"adj_close" real,
	"volume" bigint,
	CONSTRAINT "prices_daily_company_id_date_pk" PRIMARY KEY("company_id","date")
);
--> statement-breakpoint
CREATE TABLE "relationship_estimates" (
	"id" serial PRIMARY KEY NOT NULL,
	"relationship_id" integer NOT NULL,
	"as_of" date NOT NULL,
	"method" "estimate_method" NOT NULL,
	"value_cr" numeric(18, 2),
	"value_low_cr" numeric(18, 2),
	"value_high_cr" numeric(18, 2),
	"supplier_revenue_pct" real,
	"customer_cost_pct" real,
	"inputs" jsonb NOT NULL,
	"model_version" smallint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relationships" (
	"id" serial PRIMARY KEY NOT NULL,
	"supplier_company_id" integer,
	"supplier_name" text NOT NULL,
	"customer_company_id" integer,
	"customer_name" text NOT NULL,
	"cost_bucket" "cost_bucket" DEFAULT 'UNKNOWN' NOT NULL,
	"disclosed_by" "disclosed_by" NOT NULL,
	"disclosure_kind" "disclosure_kind" NOT NULL,
	"disclosed_pct" real,
	"disclosed_value" numeric(18, 2),
	"fiscal_year" smallint,
	"valid_from" date NOT NULL,
	"valid_to" date NOT NULL,
	"confidence" real NOT NULL,
	"evidence" text,
	"source_document_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signals" (
	"company_id" integer NOT NULL,
	"as_of" date NOT NULL,
	"kind" text NOT NULL,
	"value" real NOT NULL,
	"inputs" jsonb NOT NULL,
	"model_version" smallint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "signals_company_id_as_of_kind_pk" PRIMARY KEY("company_id","as_of","kind")
);
--> statement-breakpoint
ALTER TABLE "analyst_calls" ADD CONSTRAINT "analyst_calls_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analyst_calls" ADD CONSTRAINT "analyst_calls_source_document_id_documents_id_fk" FOREIGN KEY ("source_document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_aliases" ADD CONSTRAINT "company_aliases_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fundamentals" ADD CONSTRAINT "fundamentals_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fundamentals" ADD CONSTRAINT "fundamentals_source_document_id_documents_id_fk" FOREIGN KEY ("source_document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "index_constituents" ADD CONSTRAINT "index_constituents_index_id_indices_id_fk" FOREIGN KEY ("index_id") REFERENCES "public"."indices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "index_constituents" ADD CONSTRAINT "index_constituents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prices_daily" ADD CONSTRAINT "prices_daily_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationship_estimates" ADD CONSTRAINT "relationship_estimates_relationship_id_relationships_id_fk" FOREIGN KEY ("relationship_id") REFERENCES "public"."relationships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationships" ADD CONSTRAINT "relationships_supplier_company_id_companies_id_fk" FOREIGN KEY ("supplier_company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationships" ADD CONSTRAINT "relationships_customer_company_id_companies_id_fk" FOREIGN KEY ("customer_company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationships" ADD CONSTRAINT "relationships_source_document_id_documents_id_fk" FOREIGN KEY ("source_document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "analyst_calls_dedupe_uq" ON "analyst_calls" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "analyst_calls_company_date_idx" ON "analyst_calls" USING btree ("company_id","published_at");--> statement-breakpoint
CREATE UNIQUE INDEX "announcements_dedupe_uq" ON "announcements" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "announcements_company_date_idx" ON "announcements" USING btree ("company_id","published_at");--> statement-breakpoint
CREATE UNIQUE INDEX "companies_nse_symbol_uq" ON "companies" USING btree ("nse_symbol");--> statement-breakpoint
CREATE UNIQUE INDEX "companies_isin_uq" ON "companies" USING btree ("isin");--> statement-breakpoint
CREATE INDEX "companies_normalized_name_idx" ON "companies" USING btree ("normalized_name");--> statement-breakpoint
CREATE INDEX "company_aliases_alias_idx" ON "company_aliases" USING btree ("alias");--> statement-breakpoint
CREATE UNIQUE INDEX "documents_url_uq" ON "documents" USING btree ("url");--> statement-breakpoint
CREATE INDEX "documents_sha256_idx" ON "documents" USING btree ("sha256");--> statement-breakpoint
CREATE INDEX "documents_company_source_idx" ON "documents" USING btree ("company_id","source");--> statement-breakpoint
CREATE UNIQUE INDEX "fundamentals_company_period_uq" ON "fundamentals" USING btree ("company_id","period_end","period_type");--> statement-breakpoint
CREATE INDEX "ingest_runs_source_started_idx" ON "ingest_runs" USING btree ("source","started_at");--> statement-breakpoint
CREATE INDEX "prices_daily_date_idx" ON "prices_daily" USING btree ("date");--> statement-breakpoint
CREATE UNIQUE INDEX "relationship_estimates_uq" ON "relationship_estimates" USING btree ("relationship_id","as_of","model_version");--> statement-breakpoint
CREATE INDEX "relationships_supplier_idx" ON "relationships" USING btree ("supplier_company_id","valid_to");--> statement-breakpoint
CREATE INDEX "relationships_customer_idx" ON "relationships" USING btree ("customer_company_id","valid_to");--> statement-breakpoint
CREATE UNIQUE INDEX "relationships_dedupe_uq" ON "relationships" USING btree ("supplier_name","customer_name","disclosure_kind","fiscal_year","source_document_id");--> statement-breakpoint
CREATE INDEX "signals_kind_asof_idx" ON "signals" USING btree ("kind","as_of");