CREATE TABLE "document_revisions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"document_id" integer NOT NULL,
	"content_sha256" text NOT NULL,
	"text_parser_version" smallint DEFAULT 0 NOT NULL,
	"raw_sha256" text,
	"raw_s3_key" text,
	"text_s3_key" text,
	"text_bytes" integer NOT NULL,
	"page_map" jsonb,
	"mime_type" text,
	"published_at" timestamp with time zone,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"raw_unavailable" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_revisions_content_uq" UNIQUE("document_id","content_sha256","text_parser_version"),
	CONSTRAINT "document_revisions_text_bytes" CHECK ("document_revisions"."text_bytes" >= 0)
);
--> statement-breakpoint
CREATE TABLE "evidence_spans" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"document_revision_id" bigint NOT NULL,
	"start_offset" integer NOT NULL,
	"end_offset" integer NOT NULL,
	"quote" text NOT NULL,
	"page" smallint,
	"locator" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evidence_spans_range_uq" UNIQUE("document_revision_id","start_offset","end_offset"),
	CONSTRAINT "evidence_spans_range" CHECK ("evidence_spans"."start_offset" >= 0 and "evidence_spans"."end_offset" > "evidence_spans"."start_offset")
);
--> statement-breakpoint
CREATE TABLE "storage_objects" (
	"key" text PRIMARY KEY NOT NULL,
	"sha256" text NOT NULL,
	"bytes" integer NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "documents" ALTER COLUMN "content" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "text_parser_version" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "current_revision_id" bigint;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "published_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "document_revisions" ADD CONSTRAINT "document_revisions_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_spans" ADD CONSTRAINT "evidence_spans_document_revision_id_document_revisions_id_fk" FOREIGN KEY ("document_revision_id") REFERENCES "public"."document_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_revisions_document_idx" ON "document_revisions" USING btree ("document_id","fetched_at");--> statement-breakpoint
CREATE INDEX "document_revisions_text_key_idx" ON "document_revisions" USING btree ("text_s3_key");--> statement-breakpoint
CREATE INDEX "storage_objects_kind_created_idx" ON "storage_objects" USING btree ("kind","created_at");--> statement-breakpoint
CREATE INDEX "documents_inline_idx" ON "documents" USING btree ("source","id") WHERE "documents"."content" is not null;