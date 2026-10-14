CREATE TABLE "relationship_precision_sample_items" (
	"sample_id" integer NOT NULL,
	"observation_id" bigint NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "relationship_precision_sample_items_sample_id_observation_id_pk" PRIMARY KEY("sample_id","observation_id"),
	CONSTRAINT "relationship_precision_sample_items_position_ck" CHECK ("relationship_precision_sample_items"."position" > 0)
);
--> statement-breakpoint
CREATE TABLE "relationship_precision_samples" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"extractor_family" "relationship_family",
	"size" integer NOT NULL,
	"seed" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "relationship_precision_samples_name_ck" CHECK ("relationship_precision_samples"."name" ~ '^[a-z0-9_-]{1,64}$'),
	CONSTRAINT "relationship_precision_samples_size_ck" CHECK ("relationship_precision_samples"."size" > 0)
);
--> statement-breakpoint
ALTER TABLE "relationship_precision_sample_items" ADD CONSTRAINT "relationship_precision_sample_items_sample_id_relationship_precision_samples_id_fk" FOREIGN KEY ("sample_id") REFERENCES "public"."relationship_precision_samples"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationship_precision_sample_items" ADD CONSTRAINT "relationship_precision_sample_items_observation_id_relationship_observations_id_fk" FOREIGN KEY ("observation_id") REFERENCES "public"."relationship_observations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "relationship_precision_sample_items_position_uq" ON "relationship_precision_sample_items" USING btree ("sample_id","position");--> statement-breakpoint
CREATE INDEX "relationship_precision_sample_items_observation_idx" ON "relationship_precision_sample_items" USING btree ("observation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "relationship_precision_samples_name_uq" ON "relationship_precision_samples" USING btree ("name");