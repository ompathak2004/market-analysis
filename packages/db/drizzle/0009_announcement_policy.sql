CREATE TABLE "announcement_holds" (
	"announcement_id" integer NOT NULL,
	"reason" text NOT NULL,
	"evidence_span_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "announcement_holds_announcement_id_reason_pk" PRIMARY KEY("announcement_id","reason")
);
--> statement-breakpoint
CREATE TABLE "llm_usage_daily" (
	"day" date NOT NULL,
	"model" text NOT NULL,
	"kind" text NOT NULL,
	"calls" integer NOT NULL,
	"failures" integer NOT NULL,
	"prompt_tokens" bigint NOT NULL,
	"completion_tokens" bigint NOT NULL,
	"latency_ms" bigint NOT NULL,
	CONSTRAINT "llm_usage_daily_day_model_kind_pk" PRIMARY KEY("day","model","kind")
);
--> statement-breakpoint
ALTER TABLE "announcements" ADD COLUMN "category_key" text;--> statement-breakpoint
ALTER TABLE "announcements" ADD COLUMN "retention_class" text;--> statement-breakpoint
ALTER TABLE "announcements" ADD COLUMN "retain_until" date;--> statement-breakpoint
ALTER TABLE "announcements" ADD COLUMN "policy_version" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "chokepoint_transits" ADD COLUMN "ended_by" text;--> statement-breakpoint
ALTER TABLE "announcement_holds" ADD CONSTRAINT "announcement_holds_announcement_id_announcements_id_fk" FOREIGN KEY ("announcement_id") REFERENCES "public"."announcements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "announcement_holds" ADD CONSTRAINT "announcement_holds_evidence_span_id_evidence_spans_id_fk" FOREIGN KEY ("evidence_span_id") REFERENCES "public"."evidence_spans"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "announcements_retention_idx" ON "announcements" USING btree ("retention_class","retain_until");