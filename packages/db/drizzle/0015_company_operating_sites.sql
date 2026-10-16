CREATE TABLE "company_operating_sites" (
	"company_id" integer NOT NULL,
	"document_id" integer NOT NULL,
	"name" text NOT NULL,
	"state_code" text NOT NULL,
	"evidence_span_id" bigint NOT NULL,
	"observed_on" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_operating_sites_company_id_document_id_name_pk" PRIMARY KEY("company_id","document_id","name"),
	CONSTRAINT "company_operating_sites_state_ck" CHECK ("company_operating_sites"."state_code" ~ '^IN-[A-Z]{2}$')
);
--> statement-breakpoint
ALTER TABLE "company_operating_sites" ADD CONSTRAINT "company_operating_sites_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_operating_sites" ADD CONSTRAINT "company_operating_sites_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_operating_sites" ADD CONSTRAINT "company_operating_sites_evidence_span_id_evidence_spans_id_fk" FOREIGN KEY ("evidence_span_id") REFERENCES "public"."evidence_spans"("id") ON DELETE cascade ON UPDATE no action;