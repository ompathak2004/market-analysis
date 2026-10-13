CREATE TYPE "public"."ingest_run_kind" AS ENUM('legacy', 'campaign');--> statement-breakpoint
CREATE TYPE "public"."job_mode" AS ENUM('legacy', 'paused', 'worker');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('queued', 'running', 'succeeded', 'failed', 'dead', 'deferred', 'abandoned');--> statement-breakpoint
CREATE TABLE "job_attempts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" bigint NOT NULL,
	"attempt" integer NOT NULL,
	"queue_job_id" uuid,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"outcome" "job_status" DEFAULT 'running' NOT NULL,
	"error" text,
	"worker_owner" uuid,
	"generation" bigint
);
--> statement-breakpoint
CREATE TABLE "job_control" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"mode" "job_mode" DEFAULT 'legacy' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_control_singleton" CHECK ("job_control"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "job_daily_stats" (
	"day" date NOT NULL,
	"job_type" text NOT NULL,
	"succeeded" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"dead" integer DEFAULT 0 NOT NULL,
	"deferred" integer DEFAULT 0 NOT NULL,
	"abandoned" integer DEFAULT 0 NOT NULL,
	"duration_ms_total" bigint DEFAULT 0 NOT NULL,
	"duration_ms_max" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "job_daily_stats_day_job_type_pk" PRIMARY KEY("day","job_type")
);
--> statement-breakpoint
CREATE TABLE "job_runs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"job_type" text NOT NULL,
	"unit_key" text NOT NULL,
	"campaign_id" integer,
	"status" "job_status" DEFAULT 'queued' NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"lane" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone,
	"deadline_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"error" text,
	"metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_runs_unit_key" UNIQUE NULLS NOT DISTINCT("job_type","unit_key","campaign_id")
);
--> statement-breakpoint
CREATE TABLE "ops_alerts" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "ops_alerts_kind_key" UNIQUE("kind","key")
);
--> statement-breakpoint
CREATE TABLE "worker_leases" (
	"name" text PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"generation" bigint DEFAULT 1 NOT NULL,
	"leased_until" timestamp with time zone NOT NULL,
	"heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ingest_runs" ADD COLUMN "kind" "ingest_run_kind" DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "ingest_runs" ADD COLUMN "children_total" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ingest_runs" ADD COLUMN "children_done" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ingest_runs" ADD COLUMN "children_failed" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "job_attempts" ADD CONSTRAINT "job_attempts_run_id_job_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."job_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_runs" ADD CONSTRAINT "job_runs_campaign_id_ingest_runs_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."ingest_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "job_attempts_run_idx" ON "job_attempts" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "job_attempts_started_idx" ON "job_attempts" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "job_runs_status_created_idx" ON "job_runs" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "job_runs_campaign_status_idx" ON "job_runs" USING btree ("campaign_id","status");--> statement-breakpoint
INSERT INTO "job_control" ("id", "mode") VALUES (1, 'legacy') ON CONFLICT ("id") DO NOTHING;