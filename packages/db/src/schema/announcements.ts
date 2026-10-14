import { bigint, date, integer, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { announcements } from "../schema.js";
import { evidenceSpans } from "./evidence.js";

export const announcementHolds = pgTable(
  "announcement_holds",
  {
    announcementId: integer("announcement_id")
      .notNull()
      .references(() => announcements.id, { onDelete: "cascade" }),
    reason: text("reason").notNull(),
    evidenceSpanId: bigint("evidence_span_id", { mode: "number" }).references(
      () => evidenceSpans.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.announcementId, t.reason] })],
);

export const llmUsageDaily = pgTable(
  "llm_usage_daily",
  {
    day: date("day").notNull(),
    model: text("model").notNull(),
    kind: text("kind").notNull(),
    calls: integer("calls").notNull(),
    failures: integer("failures").notNull(),
    promptTokens: bigint("prompt_tokens", { mode: "number" }).notNull(),
    completionTokens: bigint("completion_tokens", { mode: "number" }).notNull(),
    latencyMs: bigint("latency_ms", { mode: "number" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.day, t.model, t.kind] })],
);
