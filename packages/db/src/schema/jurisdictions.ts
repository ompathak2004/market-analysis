import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  date,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { companies, documents, timestamps } from "../schema.js";
import { evidenceSpans } from "./evidence.js";

export const companyOperatingSites = pgTable(
  "company_operating_sites",
  {
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    documentId: integer("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    stateCode: text("state_code").notNull(),
    evidenceSpanId: bigint("evidence_span_id", { mode: "number" })
      .notNull()
      .references(() => evidenceSpans.id, { onDelete: "cascade" }),
    observedOn: date("observed_on").notNull(),
    ...timestamps,
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.documentId, t.name] }),
    check("company_operating_sites_state_ck", sql`${t.stateCode} ~ '^IN-[A-Z]{2}$'`),
  ],
);

export const stateLeadership = pgTable(
  "state_leadership",
  {
    stateCode: text("state_code").notNull(),
    stateName: text("state_name").notNull(),
    headName: text("head_name").notNull(),
    observedOn: date("observed_on").notNull(),
    sourceReviewedOn: date("source_reviewed_on"),
    evidenceSpanId: bigint("evidence_span_id", { mode: "number" })
      .notNull()
      .references(() => evidenceSpans.id, { onDelete: "cascade" }),
    parserVersion: integer("parser_version").notNull(),
    checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.stateCode, t.observedOn] }),
    check("state_leadership_code_ck", sql`${t.stateCode} ~ '^IN-[A-Z]{2}$'`),
  ],
);
