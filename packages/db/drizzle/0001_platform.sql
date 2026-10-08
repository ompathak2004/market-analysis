CREATE TYPE "public"."aircraft_link_basis" AS ENUM('owner', 'subsidiary', 'promoter_group', 'charter');--> statement-breakpoint
CREATE TYPE "public"."aircraft_tier" AS ENUM('registry', 'press', 'inferred', 'manual');--> statement-breakpoint
CREATE TYPE "public"."estimate_metric" AS ENUM('eps', 'net_profit', 'revenue');--> statement-breakpoint
CREATE TYPE "public"."facility_kind" AS ENUM('hq', 'refinery', 'spm', 'port', 'terminal', 'lng_terminal', 'plant', 'mine', 'sez', 'power_plant', 'jetty');--> statement-breakpoint
CREATE TYPE "public"."facility_role" AS ENUM('owner', 'operator', 'user');--> statement-breakpoint
CREATE TYPE "public"."flight_completeness" AS ENUM('full', 'departure_only', 'arrival_only', 'enroute');--> statement-breakpoint
CREATE TYPE "public"."holder" AS ENUM('promoter', 'fii', 'dii', 'public', 'others');--> statement-breakpoint
CREATE TYPE "public"."vessel_class" AS ENUM('tanker', 'gas', 'cargo', 'container', 'passenger', 'other');--> statement-breakpoint
CREATE TABLE "aircraft_flights" (
	"id" serial PRIMARY KEY NOT NULL,
	"aircraft_id" integer NOT NULL,
	"hex" text NOT NULL,
	"departed_at" timestamp with time zone,
	"arrived_at" timestamp with time zone,
	"duration_min" integer,
	"dep_icao" text,
	"dep_city" text,
	"dep_country" text,
	"arr_icao" text,
	"arr_city" text,
	"arr_country" text,
	"completeness" "flight_completeness" NOT NULL,
	"source" text NOT NULL,
	"samples" integer DEFAULT 0 NOT NULL,
	"max_alt_ft" integer,
	"dedupe_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "aircraft_flights_dedupe_key_unique" UNIQUE("dedupe_key")
);
--> statement-breakpoint
CREATE TABLE "aircraft_positions" (
	"hex" text NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"lat" real,
	"lon" real,
	"alt_ft" integer,
	"gs_kt" real,
	"track" real,
	"on_ground" boolean NOT NULL,
	"squawk" text,
	"source" text DEFAULT 'adsb_lol' NOT NULL,
	CONSTRAINT "aircraft_positions_hex_ts_pk" PRIMARY KEY("hex","ts")
);
--> statement-breakpoint
CREATE TABLE "altdata_coverage" (
	"layer" text NOT NULL,
	"zone" text NOT NULL,
	"day" date NOT NULL,
	"windows" integer DEFAULT 0 NOT NULL,
	"windows_with_data" integer DEFAULT 0 NOT NULL,
	"messages" integer DEFAULT 0 NOT NULL,
	"unique_ids" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "altdata_coverage_layer_zone_day_pk" PRIMARY KEY("layer","zone","day")
);
--> statement-breakpoint
CREATE TABLE "altdata_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"layer" text NOT NULL,
	"kind" text NOT NULL,
	"company_id" integer,
	"facility_id" integer,
	"occurred_at" timestamp with time zone NOT NULL,
	"headline" text NOT NULL,
	"detail" jsonb NOT NULL,
	"severity" smallint DEFAULT 1 NOT NULL,
	"dedupe_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "altdata_events_dedupe_key_unique" UNIQUE("dedupe_key")
);
--> statement-breakpoint
CREATE TABLE "analyst_ratings" (
	"company_id" integer NOT NULL,
	"as_of" date NOT NULL,
	"buy_pct" real,
	"outperform_pct" real,
	"hold_pct" real,
	"underperform_pct" real,
	"sell_pct" real,
	"analyst_count" smallint,
	"final_rating" text,
	"source" text DEFAULT 'moneycontrol' NOT NULL,
	"parser_version" smallint NOT NULL,
	CONSTRAINT "analyst_ratings_company_id_as_of_pk" PRIMARY KEY("company_id","as_of")
);
--> statement-breakpoint
CREATE TABLE "chokepoint_transits" (
	"id" serial PRIMARY KEY NOT NULL,
	"mmsi" integer NOT NULL,
	"chokepoint" text NOT NULL,
	"entered_at" timestamp with time zone NOT NULL,
	"left_at" timestamp with time zone,
	"loiter_min" integer DEFAULT 0 NOT NULL,
	"min_sog_kt" real,
	"destination_at_entry" text,
	"destination_facility_id" integer,
	"direction" text
);
--> statement-breakpoint
CREATE TABLE "company_facts" (
	"company_id" integer NOT NULL,
	"source" text NOT NULL,
	"parser_version" smallint NOT NULL,
	"facts" jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_facts_company_id_source_pk" PRIMARY KEY("company_id","source")
);
--> statement-breakpoint
CREATE TABLE "company_sync" (
	"company_id" integer NOT NULL,
	"job" text NOT NULL,
	"synced_at" timestamp with time zone,
	"attempted_at" timestamp with time zone,
	"failures" smallint DEFAULT 0 NOT NULL,
	"error" text,
	CONSTRAINT "company_sync_company_id_job_pk" PRIMARY KEY("company_id","job")
);
--> statement-breakpoint
CREATE TABLE "consensus_history" (
	"company_id" integer NOT NULL,
	"month" date NOT NULL,
	"buy" smallint,
	"outperform" smallint,
	"hold" smallint,
	"underperform" smallint,
	"sell" smallint,
	"source" text DEFAULT 'moneycontrol' NOT NULL,
	"parser_version" smallint NOT NULL,
	CONSTRAINT "consensus_history_company_id_month_pk" PRIMARY KEY("company_id","month")
);
--> statement-breakpoint
CREATE TABLE "corporate_aircraft" (
	"id" serial PRIMARY KEY NOT NULL,
	"registration" text NOT NULL,
	"icao_hex" text NOT NULL,
	"icao_type" text,
	"model" text,
	"owner_name" text,
	"operator_name" text,
	"group_name" text,
	"linked_person" text,
	"linked_role" text,
	"tier" "aircraft_tier" NOT NULL,
	"confidence" real NOT NULL,
	"privacy_flagged" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"home_icao" text,
	"source_url" text,
	"verified_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "corporate_aircraft_registration_unique" UNIQUE("registration"),
	CONSTRAINT "corporate_aircraft_icao_hex_unique" UNIQUE("icao_hex")
);
--> statement-breakpoint
CREATE TABLE "corporate_aircraft_companies" (
	"aircraft_id" integer NOT NULL,
	"company_id" integer NOT NULL,
	"basis" "aircraft_link_basis" NOT NULL,
	CONSTRAINT "corporate_aircraft_companies_aircraft_id_company_id_pk" PRIMARY KEY("aircraft_id","company_id")
);
--> statement-breakpoint
CREATE TABLE "earnings_estimates" (
	"company_id" integer NOT NULL,
	"metric" "estimate_metric" NOT NULL,
	"fiscal_year_end" date NOT NULL,
	"consolidated" boolean DEFAULT true NOT NULL,
	"as_of" date NOT NULL,
	"low" numeric(18, 2),
	"high" numeric(18, 2),
	"avg" numeric(18, 2),
	"actual" numeric(18, 2),
	"source" text DEFAULT 'moneycontrol' NOT NULL,
	"parser_version" smallint NOT NULL,
	CONSTRAINT "earnings_estimates_company_id_metric_fiscal_year_end_consolidated_as_of_pk" PRIMARY KEY("company_id","metric","fiscal_year_end","consolidated","as_of")
);
--> statement-breakpoint
CREATE TABLE "earnings_surprises" (
	"company_id" integer NOT NULL,
	"metric" "estimate_metric" NOT NULL,
	"quarter_end" date NOT NULL,
	"actual" numeric(18, 2),
	"estimate" numeric(18, 2),
	"surprise_pct" real,
	"outcome" text NOT NULL,
	"source" text DEFAULT 'moneycontrol' NOT NULL,
	"parser_version" smallint NOT NULL,
	CONSTRAINT "earnings_surprises_company_id_metric_quarter_end_pk" PRIMARY KEY("company_id","metric","quarter_end")
);
--> statement-breakpoint
CREATE TABLE "facilities" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"kind" "facility_kind" NOT NULL,
	"lat" real NOT NULL,
	"lon" real NOT NULL,
	"radius_km" real NOT NULL,
	"country" text DEFAULT 'IN' NOT NULL,
	"locode" text,
	"aliases" text[] DEFAULT '{}'::text[] NOT NULL,
	"exclusive" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"source_url" text,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "facilities_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "facility_companies" (
	"facility_id" integer NOT NULL,
	"company_id" integer NOT NULL,
	"role" "facility_role" NOT NULL,
	"commodity_in" text[] DEFAULT '{}'::text[] NOT NULL,
	"commodity_out" text[] DEFAULT '{}'::text[] NOT NULL,
	"note" text,
	CONSTRAINT "facility_companies_facility_id_company_id_pk" PRIMARY KEY("facility_id","company_id")
);
--> statement-breakpoint
CREATE TABLE "index_prices_daily" (
	"index_id" integer NOT NULL,
	"date" date NOT NULL,
	"open" real,
	"high" real,
	"low" real,
	"close" real NOT NULL,
	"volume" bigint,
	CONSTRAINT "index_prices_daily_index_id_date_pk" PRIMARY KEY("index_id","date")
);
--> statement-breakpoint
CREATE TABLE "insights" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" integer,
	"kind" text NOT NULL,
	"subject_id" integer,
	"model_version" smallint NOT NULL,
	"model" text NOT NULL,
	"input_hash" text NOT NULL,
	"inputs" jsonb NOT NULL,
	"output" jsonb NOT NULL,
	"confidence" real,
	"prompt_tokens" integer,
	"completion_tokens" integer,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"superseded_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "llm_usage" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"model" text NOT NULL,
	"prompt_tokens" integer NOT NULL,
	"completion_tokens" integer NOT NULL,
	"latency_ms" integer NOT NULL,
	"ok" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "price_targets" (
	"company_id" integer NOT NULL,
	"as_of" date NOT NULL,
	"low" real,
	"mean" real,
	"high" real,
	"source" text DEFAULT 'moneycontrol' NOT NULL,
	"parser_version" smallint NOT NULL,
	CONSTRAINT "price_targets_company_id_as_of_pk" PRIMARY KEY("company_id","as_of")
);
--> statement-breakpoint
CREATE TABLE "shareholding" (
	"company_id" integer NOT NULL,
	"quarter_end" date NOT NULL,
	"holder" "holder" NOT NULL,
	"pct" real NOT NULL,
	"pledge_pct" real,
	"source" text DEFAULT 'moneycontrol' NOT NULL,
	"parser_version" smallint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shareholding_company_id_quarter_end_holder_pk" PRIMARY KEY("company_id","quarter_end","holder")
);
--> statement-breakpoint
CREATE TABLE "vessel_calls" (
	"id" serial PRIMARY KEY NOT NULL,
	"mmsi" integer NOT NULL,
	"facility_id" integer NOT NULL,
	"entered_at" timestamp with time zone NOT NULL,
	"left_at" timestamp with time zone,
	"dwell_min" integer,
	"draught_in" real,
	"draught_out" real,
	"cargo_direction" text,
	"nav_status_mode" smallint,
	"positions" integer DEFAULT 0 NOT NULL,
	"ended_by" text
);
--> statement-breakpoint
CREATE TABLE "vessel_fleet" (
	"imo" integer PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"dwt" integer,
	"type" text,
	"company_id" integer NOT NULL,
	"source_url" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vessel_positions" (
	"mmsi" integer NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"lat" real NOT NULL,
	"lon" real NOT NULL,
	"sog_kt" real,
	"cog_deg" real,
	"heading_deg" smallint,
	"nav_status" smallint,
	CONSTRAINT "vessel_positions_mmsi_ts_pk" PRIMARY KEY("mmsi","ts")
);
--> statement-breakpoint
CREATE TABLE "vessels" (
	"mmsi" integer PRIMARY KEY NOT NULL,
	"imo" integer,
	"name" text,
	"call_sign" text,
	"flag" text,
	"ship_type" smallint,
	"class" "vessel_class" DEFAULT 'other' NOT NULL,
	"length_m" smallint,
	"beam_m" smallint,
	"draught_m" real,
	"size_class" text,
	"dwt_est" integer,
	"dwt" integer,
	"destination_raw" text,
	"destination_facility_id" integer,
	"eta_raw" text,
	"owner_company_id" integer,
	"owner_source_url" text,
	"static_updated_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "analyst_calls" ADD COLUMN "title" text;--> statement-breakpoint
ALTER TABLE "analyst_calls" ADD COLUMN "summary" text;--> statement-breakpoint
ALTER TABLE "analyst_calls" ADD COLUMN "report_document_id" integer;--> statement-breakpoint
ALTER TABLE "analyst_calls" ADD COLUMN "thesis" jsonb;--> statement-breakpoint
ALTER TABLE "analyst_calls" ADD COLUMN "summary_model_version" smallint;--> statement-breakpoint
ALTER TABLE "analyst_calls" ADD COLUMN "summarized_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "announcements" ADD COLUMN "materiality" text;--> statement-breakpoint
ALTER TABLE "announcements" ADD COLUMN "triage_category" text;--> statement-breakpoint
ALTER TABLE "announcements" ADD COLUMN "so_what" text;--> statement-breakpoint
ALTER TABLE "announcements" ADD COLUMN "triage_model_version" smallint;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "moneycontrol_code" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "moneycontrol_url" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "registered_city" text;--> statement-breakpoint
ALTER TABLE "aircraft_flights" ADD CONSTRAINT "aircraft_flights_aircraft_id_corporate_aircraft_id_fk" FOREIGN KEY ("aircraft_id") REFERENCES "public"."corporate_aircraft"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "altdata_events" ADD CONSTRAINT "altdata_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "altdata_events" ADD CONSTRAINT "altdata_events_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analyst_ratings" ADD CONSTRAINT "analyst_ratings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chokepoint_transits" ADD CONSTRAINT "chokepoint_transits_mmsi_vessels_mmsi_fk" FOREIGN KEY ("mmsi") REFERENCES "public"."vessels"("mmsi") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chokepoint_transits" ADD CONSTRAINT "chokepoint_transits_destination_facility_id_facilities_id_fk" FOREIGN KEY ("destination_facility_id") REFERENCES "public"."facilities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_facts" ADD CONSTRAINT "company_facts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_sync" ADD CONSTRAINT "company_sync_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consensus_history" ADD CONSTRAINT "consensus_history_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "corporate_aircraft_companies" ADD CONSTRAINT "corporate_aircraft_companies_aircraft_id_corporate_aircraft_id_fk" FOREIGN KEY ("aircraft_id") REFERENCES "public"."corporate_aircraft"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "corporate_aircraft_companies" ADD CONSTRAINT "corporate_aircraft_companies_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "earnings_estimates" ADD CONSTRAINT "earnings_estimates_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "earnings_surprises" ADD CONSTRAINT "earnings_surprises_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facility_companies" ADD CONSTRAINT "facility_companies_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facility_companies" ADD CONSTRAINT "facility_companies_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "index_prices_daily" ADD CONSTRAINT "index_prices_daily_index_id_indices_id_fk" FOREIGN KEY ("index_id") REFERENCES "public"."indices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "insights" ADD CONSTRAINT "insights_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_targets" ADD CONSTRAINT "price_targets_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shareholding" ADD CONSTRAINT "shareholding_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vessel_calls" ADD CONSTRAINT "vessel_calls_mmsi_vessels_mmsi_fk" FOREIGN KEY ("mmsi") REFERENCES "public"."vessels"("mmsi") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vessel_calls" ADD CONSTRAINT "vessel_calls_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vessel_fleet" ADD CONSTRAINT "vessel_fleet_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vessels" ADD CONSTRAINT "vessels_destination_facility_id_facilities_id_fk" FOREIGN KEY ("destination_facility_id") REFERENCES "public"."facilities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vessels" ADD CONSTRAINT "vessels_owner_company_id_companies_id_fk" FOREIGN KEY ("owner_company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "aircraft_flights_aircraft_departed_idx" ON "aircraft_flights" USING btree ("aircraft_id","departed_at");--> statement-breakpoint
CREATE INDEX "aircraft_positions_ts_idx" ON "aircraft_positions" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "altdata_events_occurred_idx" ON "altdata_events" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "altdata_events_company_occurred_idx" ON "altdata_events" USING btree ("company_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "chokepoint_transits_uq" ON "chokepoint_transits" USING btree ("mmsi","chokepoint","entered_at");--> statement-breakpoint
CREATE INDEX "chokepoint_transits_cp_entered_idx" ON "chokepoint_transits" USING btree ("chokepoint","entered_at");--> statement-breakpoint
CREATE INDEX "company_sync_job_synced_idx" ON "company_sync" USING btree ("job","synced_at");--> statement-breakpoint
CREATE INDEX "corporate_aircraft_active_idx" ON "corporate_aircraft" USING btree ("active");--> statement-breakpoint
CREATE INDEX "facilities_kind_idx" ON "facilities" USING btree ("kind");--> statement-breakpoint
CREATE UNIQUE INDEX "insights_key_uq" ON "insights" USING btree ("company_id","kind","subject_id","model_version","input_hash");--> statement-breakpoint
CREATE INDEX "insights_current_idx" ON "insights" USING btree ("kind","company_id","generated_at");--> statement-breakpoint
CREATE INDEX "llm_usage_created_idx" ON "llm_usage" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "vessel_calls_uq" ON "vessel_calls" USING btree ("mmsi","facility_id","entered_at");--> statement-breakpoint
CREATE INDEX "vessel_calls_facility_entered_idx" ON "vessel_calls" USING btree ("facility_id","entered_at");--> statement-breakpoint
CREATE INDEX "vessel_fleet_company_idx" ON "vessel_fleet" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "vessel_positions_ts_idx" ON "vessel_positions" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "vessels_imo_idx" ON "vessels" USING btree ("imo");--> statement-breakpoint
CREATE INDEX "vessels_destination_facility_idx" ON "vessels" USING btree ("destination_facility_id");--> statement-breakpoint
ALTER TABLE "analyst_calls" ADD CONSTRAINT "analyst_calls_report_document_id_documents_id_fk" FOREIGN KEY ("report_document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "announcements_published_idx" ON "announcements" USING btree ("published_at");