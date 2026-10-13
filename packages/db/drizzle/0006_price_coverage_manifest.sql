CREATE TABLE "price_manifest_companies" (
	"manifest_id" integer NOT NULL,
	"company_id" integer NOT NULL,
	"series_id" integer,
	"symbol" text,
	"units" integer DEFAULT 0 NOT NULL,
	"exception_reason" text,
	CONSTRAINT "price_manifest_companies_manifest_id_company_id_pk" PRIMARY KEY("manifest_id","company_id")
);
--> statement-breakpoint
CREATE TABLE "price_manifests" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"desired_from" date NOT NULL,
	"desired_to" date NOT NULL,
	"companies" integer NOT NULL,
	"units" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "price_series_state" ADD COLUMN "exception_reason" text;--> statement-breakpoint
ALTER TABLE "price_series_state" ADD COLUMN "detail" text;--> statement-breakpoint
ALTER TABLE "price_manifest_companies" ADD CONSTRAINT "price_manifest_companies_manifest_id_price_manifests_id_fk" FOREIGN KEY ("manifest_id") REFERENCES "public"."price_manifests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_manifest_companies" ADD CONSTRAINT "price_manifest_companies_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_manifest_companies" ADD CONSTRAINT "price_manifest_companies_series_id_price_series_state_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."price_series_state"("id") ON DELETE set null ON UPDATE no action;