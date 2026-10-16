CREATE TABLE "state_leadership" (
	"state_code" text NOT NULL,
	"state_name" text NOT NULL,
	"head_name" text NOT NULL,
	"observed_on" date NOT NULL,
	"source_reviewed_on" date,
	"evidence_span_id" bigint NOT NULL,
	"parser_version" integer NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "state_leadership_state_code_observed_on_pk" PRIMARY KEY("state_code","observed_on"),
	CONSTRAINT "state_leadership_code_ck" CHECK ("state_leadership"."state_code" ~ '^IN-[A-Z]{2}$')
);
--> statement-breakpoint
ALTER TABLE "aircraft_flights" ADD COLUMN "parser_version" smallint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "aircraft_flights" ADD COLUMN "dep_method" text;--> statement-breakpoint
ALTER TABLE "aircraft_flights" ADD COLUMN "arr_method" text;--> statement-breakpoint
ALTER TABLE "facilities" ADD COLUMN "state_code" text;--> statement-breakpoint
ALTER TABLE "facilities" ADD COLUMN "jurisdiction_source_url" text;--> statement-breakpoint
ALTER TABLE "state_leadership" ADD CONSTRAINT "state_leadership_evidence_span_id_evidence_spans_id_fk" FOREIGN KEY ("evidence_span_id") REFERENCES "public"."evidence_spans"("id") ON DELETE cascade ON UPDATE no action;