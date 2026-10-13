CREATE TABLE "corporate_actions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"company_id" integer NOT NULL,
	"action_type" text NOT NULL,
	"ex_date" date NOT NULL,
	"event_key" text NOT NULL,
	"split_numerator" double precision,
	"split_denominator" double precision,
	"cash_amount" double precision,
	"currency" text,
	"source" text NOT NULL,
	"source_revision_id" bigint,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"corrected_at" timestamp with time zone,
	CONSTRAINT "corporate_actions_company_event" UNIQUE("company_id","event_key"),
	CONSTRAINT "corporate_actions_split_ratio" CHECK ("corporate_actions"."action_type" = 'dividend' or ("corporate_actions"."split_numerator" > 0 and "corporate_actions"."split_denominator" > 0)),
	CONSTRAINT "corporate_actions_cash" CHECK ("corporate_actions"."cash_amount" is null or "corporate_actions"."cash_amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "market_symbols" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" integer,
	"index_id" integer,
	"provider" text NOT NULL,
	"symbol" text NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date,
	"verified_at" timestamp with time zone,
	"source_document_revision_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "market_symbols_provider_symbol_from" UNIQUE("provider","symbol","valid_from"),
	CONSTRAINT "market_symbols_one_owner" CHECK (num_nonnulls("market_symbols"."company_id", "market_symbols"."index_id") = 1),
	CONSTRAINT "market_symbols_range" CHECK ("market_symbols"."valid_to" is null or "market_symbols"."valid_to" > "market_symbols"."valid_from")
);
--> statement-breakpoint
CREATE TABLE "price_gaps" (
	"series_id" integer NOT NULL,
	"from_date" date NOT NULL,
	"to_date" date NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"sessions" integer DEFAULT 0 NOT NULL,
	"checks" integer DEFAULT 0 NOT NULL,
	"next_check_at" timestamp with time zone,
	"evidence_revision_id" bigint,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "price_gaps_series_id_from_date_to_date_pk" PRIMARY KEY("series_id","from_date","to_date"),
	CONSTRAINT "price_gaps_range" CHECK ("price_gaps"."from_date" <= "price_gaps"."to_date")
);
--> statement-breakpoint
CREATE TABLE "price_series_state" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" integer,
	"index_id" integer,
	"desired_from" date NOT NULL,
	"desired_to" date NOT NULL,
	"verified_through" date,
	"adjustment_generation" integer DEFAULT 0 NOT NULL,
	"action_hash" text,
	"quality_status" text DEFAULT 'pending' NOT NULL,
	"checked_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "price_series_state_company_id_unique" UNIQUE("company_id"),
	CONSTRAINT "price_series_state_index_id_unique" UNIQUE("index_id"),
	CONSTRAINT "price_series_state_one_owner" CHECK (num_nonnulls("price_series_state"."company_id", "price_series_state"."index_id") = 1),
	CONSTRAINT "price_series_state_range" CHECK ("price_series_state"."desired_from" <= "price_series_state"."desired_to")
);
--> statement-breakpoint
CREATE TABLE "trading_sessions" (
	"exchange" text NOT NULL,
	"date" date NOT NULL,
	"opens_at" timestamp with time zone,
	"closes_at" timestamp with time zone,
	"session_type" text DEFAULT 'regular' NOT NULL,
	"source" text NOT NULL,
	"source_url" text,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trading_sessions_exchange_date_pk" PRIMARY KEY("exchange","date")
);
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "listed_from" date;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "delisted_on" date;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "listing_status" text DEFAULT 'unverified' NOT NULL;--> statement-breakpoint
ALTER TABLE "index_prices_daily" ADD COLUMN "source" text DEFAULT 'legacy_yahoo' NOT NULL;--> statement-breakpoint
ALTER TABLE "index_prices_daily" ADD COLUMN "source_symbol" text;--> statement-breakpoint
ALTER TABLE "index_prices_daily" ADD COLUMN "fetched_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "index_prices_daily" ADD COLUMN "parser_version" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "index_prices_daily" ADD COLUMN "adjustment_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "index_prices_daily" ADD COLUMN "is_final" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "index_prices_daily" ALTER COLUMN "is_final" SET DEFAULT false;--> statement-breakpoint
ALTER TABLE "prices_daily" ADD COLUMN "source" text DEFAULT 'legacy_yahoo' NOT NULL;--> statement-breakpoint
ALTER TABLE "prices_daily" ADD COLUMN "source_symbol" text;--> statement-breakpoint
ALTER TABLE "prices_daily" ADD COLUMN "fetched_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "prices_daily" ADD COLUMN "parser_version" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "prices_daily" ADD COLUMN "adjustment_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "prices_daily" ADD COLUMN "is_final" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "prices_daily" ALTER COLUMN "is_final" SET DEFAULT false;--> statement-breakpoint
ALTER TABLE "prices_daily" ADD COLUMN "adjustment_status" text DEFAULT 'unverified' NOT NULL;--> statement-breakpoint
ALTER TABLE "corporate_actions" ADD CONSTRAINT "corporate_actions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_symbols" ADD CONSTRAINT "market_symbols_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_symbols" ADD CONSTRAINT "market_symbols_index_id_indices_id_fk" FOREIGN KEY ("index_id") REFERENCES "public"."indices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_gaps" ADD CONSTRAINT "price_gaps_series_id_price_series_state_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."price_series_state"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_series_state" ADD CONSTRAINT "price_series_state_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_series_state" ADD CONSTRAINT "price_series_state_index_id_indices_id_fk" FOREIGN KEY ("index_id") REFERENCES "public"."indices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "corporate_actions_ex_date_idx" ON "corporate_actions" USING btree ("ex_date");--> statement-breakpoint
CREATE INDEX "market_symbols_company_idx" ON "market_symbols" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "market_symbols_index_idx" ON "market_symbols" USING btree ("index_id");--> statement-breakpoint
CREATE INDEX "price_gaps_due_idx" ON "price_gaps" USING btree ("status","next_check_at");--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_listing_status_chk" CHECK ("companies"."listing_status" in ('active','suspended','delisted','placeholder','unverified'));