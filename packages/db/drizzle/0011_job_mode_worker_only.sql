ALTER TABLE "job_control" ALTER COLUMN "mode" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "job_control" ALTER COLUMN "mode" SET DEFAULT 'paused'::text;--> statement-breakpoint
UPDATE "job_control" SET "mode" = 'paused' WHERE "mode" = 'legacy';--> statement-breakpoint
DROP TYPE "public"."job_mode";--> statement-breakpoint
CREATE TYPE "public"."job_mode" AS ENUM('paused', 'worker');--> statement-breakpoint
ALTER TABLE "job_control" ALTER COLUMN "mode" SET DEFAULT 'paused'::"public"."job_mode";--> statement-breakpoint
ALTER TABLE "job_control" ALTER COLUMN "mode" SET DATA TYPE "public"."job_mode" USING "mode"::"public"."job_mode";--> statement-breakpoint
UPDATE "ingest_runs" SET "status" = 'failed', "finished_at" = now(), "error" = 'abandoned_legacy_execution'
  WHERE "kind" = 'legacy' AND "status" = 'running';
