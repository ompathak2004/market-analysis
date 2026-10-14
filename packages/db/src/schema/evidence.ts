import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { documents } from "../schema.js";

export interface PageSpan {
  page: number;
  start: number;
  end: number;
}

export const documentRevisions = pgTable(
  "document_revisions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    documentId: integer("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    contentSha256: text("content_sha256").notNull(),
    textParserVersion: smallint("text_parser_version").notNull().default(0),
    rawSha256: text("raw_sha256"),
    rawS3Key: text("raw_s3_key"),
    textS3Key: text("text_s3_key"),
    textBytes: integer("text_bytes").notNull(),
    pageMap: jsonb("page_map").$type<PageSpan[]>(),
    mimeType: text("mime_type"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
    rawUnavailable: boolean("raw_unavailable").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("document_revisions_content_uq").on(t.documentId, t.contentSha256, t.textParserVersion),
    index("document_revisions_document_idx").on(t.documentId, t.fetchedAt),
    index("document_revisions_text_key_idx").on(t.textS3Key),
    check("document_revisions_text_bytes", sql`${t.textBytes} >= 0`),
  ],
);

export const evidenceSpans = pgTable(
  "evidence_spans",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    documentRevisionId: bigint("document_revision_id", { mode: "number" })
      .notNull()
      .references(() => documentRevisions.id, { onDelete: "cascade" }),
    startOffset: integer("start_offset").notNull(),
    endOffset: integer("end_offset").notNull(),
    quote: text("quote").notNull(),
    page: smallint("page"),
    locator: jsonb("locator").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("evidence_spans_range_uq").on(t.documentRevisionId, t.startOffset, t.endOffset),
    check("evidence_spans_range", sql`${t.startOffset} >= 0 and ${t.endOffset} > ${t.startOffset}`),
  ],
);

export const storageObjects = pgTable(
  "storage_objects",
  {
    key: text("key").primaryKey(),
    sha256: text("sha256").notNull(),
    bytes: integer("bytes").notNull(),
    kind: text("kind").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("storage_objects_kind_created_idx").on(t.kind, t.createdAt)],
);
