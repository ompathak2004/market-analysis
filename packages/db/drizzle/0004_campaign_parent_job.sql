ALTER TABLE "ingest_runs" ADD COLUMN "parent_job_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "ingest_runs_parent_job_idx" ON "ingest_runs" USING btree ("parent_job_id");