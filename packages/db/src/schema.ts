import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  serial,
  smallint,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

export const periodType = pgEnum("period_type", ["annual", "quarterly", "ttm"]);
export const costBucket = pgEnum("cost_bucket", ["COGS", "CAPEX", "SGA", "RND", "UNKNOWN"]);
export const disclosedBy = pgEnum("disclosed_by", ["supplier", "customer", "third_party"]);
export const disclosureKind = pgEnum("disclosure_kind", [
  "major_customer",
  "related_party",
  "segment",
  "contract",
  "press",
  "manual",
]);
export const estimateMethod = pgEnum("estimate_method", ["disclosed", "derived", "estimated"]);
export const analystAction = pgEnum("analyst_action", [
  "initiate",
  "maintain",
  "upgrade",
  "downgrade",
  "raise_target",
  "lower_target",
  "reiterate",
  "unknown",
]);
export const documentStatus = pgEnum("document_status", ["fetched", "parsed", "failed", "skipped"]);
export const ingestStatus = pgEnum("ingest_status", ["running", "succeeded", "failed"]);

export const companies = pgTable(
  "companies",
  {
    id: serial("id").primaryKey(),
    nseSymbol: text("nse_symbol"),
    bseCode: text("bse_code"),
    isin: text("isin"),
    name: text("name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    sector: text("sector"),
    industry: text("industry"),
    screenerSlug: text("screener_slug"),
    yahooSymbol: text("yahoo_symbol"),
    marketCapCr: numeric("market_cap_cr", { precision: 18, scale: 2 }),
    listed: boolean("listed").notNull().default(true),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("companies_nse_symbol_uq").on(t.nseSymbol),
    uniqueIndex("companies_isin_uq").on(t.isin),
    index("companies_normalized_name_idx").on(t.normalizedName),
  ],
);

export const companyAliases = pgTable(
  "company_aliases",
  {
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    alias: text("alias").notNull(),
  },
  (t) => [primaryKey({ columns: [t.companyId, t.alias] }), index("company_aliases_alias_idx").on(t.alias)],
);

export const indices = pgTable("indices", {
  id: serial("id").primaryKey(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  yahooSymbol: text("yahoo_symbol"),
});

export const indexConstituents = pgTable(
  "index_constituents",
  {
    indexId: integer("index_id")
      .notNull()
      .references(() => indices.id, { onDelete: "cascade" }),
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    weight: real("weight"),
  },
  (t) => [primaryKey({ columns: [t.indexId, t.companyId] })],
);

export const pricesDaily = pgTable(
  "prices_daily",
  {
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    date: date("date").notNull(),
    open: real("open"),
    high: real("high"),
    low: real("low"),
    close: real("close").notNull(),
    adjClose: real("adj_close"),
    volume: bigint("volume", { mode: "number" }),
  },
  (t) => [primaryKey({ columns: [t.companyId, t.date] }), index("prices_daily_date_idx").on(t.date)],
);

export const fundamentals = pgTable(
  "fundamentals",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    periodEnd: date("period_end").notNull(),
    periodType: periodType("period_type").notNull(),
    revenue: numeric("revenue", { precision: 18, scale: 2 }),
    cogs: numeric("cogs", { precision: 18, scale: 2 }),
    sga: numeric("sga", { precision: 18, scale: 2 }),
    rnd: numeric("rnd", { precision: 18, scale: 2 }),
    capex: numeric("capex", { precision: 18, scale: 2 }),
    operatingProfit: numeric("operating_profit", { precision: 18, scale: 2 }),
    interestExpense: numeric("interest_expense", { precision: 18, scale: 2 }),
    pretaxIncome: numeric("pretax_income", { precision: 18, scale: 2 }),
    netIncome: numeric("net_income", { precision: 18, scale: 2 }),
    totalAssets: numeric("total_assets", { precision: 18, scale: 2 }),
    totalEquity: numeric("total_equity", { precision: 18, scale: 2 }),
    totalDebt: numeric("total_debt", { precision: 18, scale: 2 }),
    currentAssets: numeric("current_assets", { precision: 18, scale: 2 }),
    currentLiabilities: numeric("current_liabilities", { precision: 18, scale: 2 }),
    retainedEarnings: numeric("retained_earnings", { precision: 18, scale: 2 }),
    cashFromOps: numeric("cash_from_ops", { precision: 18, scale: 2 }),
    sourceDocumentId: integer("source_document_id").references(() => documents.id),
    ...timestamps,
  },
  (t) => [uniqueIndex("fundamentals_company_period_uq").on(t.companyId, t.periodEnd, t.periodType)],
);

export const documents = pgTable(
  "documents",
  {
    id: serial("id").primaryKey(),
    url: text("url").notNull(),
    source: text("source").notNull(),
    companyId: integer("company_id").references(() => companies.id, { onDelete: "set null" }),
    sha256: text("sha256").notNull(),
    contentType: text("content_type"),
    etag: text("etag"),
    lastModified: text("last_modified"),
    byteSize: integer("byte_size").notNull(),
    content: text("content").notNull(),
    status: documentStatus("status").notNull().default("fetched"),
    parserVersion: smallint("parser_version"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
    parsedAt: timestamp("parsed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("documents_url_uq").on(t.url),
    index("documents_sha256_idx").on(t.sha256),
    index("documents_company_source_idx").on(t.companyId, t.source),
  ],
);

export const relationships = pgTable(
  "relationships",
  {
    id: serial("id").primaryKey(),
    supplierCompanyId: integer("supplier_company_id").references(() => companies.id, { onDelete: "set null" }),
    supplierName: text("supplier_name").notNull(),
    customerCompanyId: integer("customer_company_id").references(() => companies.id, { onDelete: "set null" }),
    customerName: text("customer_name").notNull(),
    costBucket: costBucket("cost_bucket").notNull().default("UNKNOWN"),
    disclosedBy: disclosedBy("disclosed_by").notNull(),
    disclosureKind: disclosureKind("disclosure_kind").notNull(),
    disclosedPct: real("disclosed_pct"),
    disclosedValue: numeric("disclosed_value", { precision: 18, scale: 2 }),
    fiscalYear: smallint("fiscal_year"),
    validFrom: date("valid_from").notNull(),
    validTo: date("valid_to").notNull(),
    confidence: real("confidence").notNull(),
    evidence: text("evidence"),
    sourceDocumentId: integer("source_document_id").references(() => documents.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [
    index("relationships_supplier_idx").on(t.supplierCompanyId, t.validTo),
    index("relationships_customer_idx").on(t.customerCompanyId, t.validTo),
    uniqueIndex("relationships_dedupe_uq").on(
      t.supplierName,
      t.customerName,
      t.disclosureKind,
      t.fiscalYear,
      t.sourceDocumentId,
    ),
  ],
);

export const relationshipEstimates = pgTable(
  "relationship_estimates",
  {
    id: serial("id").primaryKey(),
    relationshipId: integer("relationship_id")
      .notNull()
      .references(() => relationships.id, { onDelete: "cascade" }),
    asOf: date("as_of").notNull(),
    method: estimateMethod("method").notNull(),
    valueCr: numeric("value_cr", { precision: 18, scale: 2 }),
    valueLowCr: numeric("value_low_cr", { precision: 18, scale: 2 }),
    valueHighCr: numeric("value_high_cr", { precision: 18, scale: 2 }),
    supplierRevenuePct: real("supplier_revenue_pct"),
    customerCostPct: real("customer_cost_pct"),
    inputs: jsonb("inputs").$type<Record<string, unknown>>().notNull(),
    modelVersion: smallint("model_version").notNull(),
    createdAt: timestamps.createdAt,
  },
  (t) => [uniqueIndex("relationship_estimates_uq").on(t.relationshipId, t.asOf, t.modelVersion)],
);

export const analystCalls = pgTable(
  "analyst_calls",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    broker: text("broker").notNull(),
    publishedAt: date("published_at").notNull(),
    action: analystAction("action").notNull().default("unknown"),
    rating: text("rating").notNull(),
    priorRating: text("prior_rating"),
    targetPrice: real("target_price"),
    priorTargetPrice: real("prior_target_price"),
    priceAtCall: real("price_at_call"),
    reportUrl: text("report_url"),
    source: text("source").notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    sourceDocumentId: integer("source_document_id").references(() => documents.id, { onDelete: "set null" }),
    createdAt: timestamps.createdAt,
  },
  (t) => [
    uniqueIndex("analyst_calls_dedupe_uq").on(t.dedupeKey),
    index("analyst_calls_company_date_idx").on(t.companyId, t.publishedAt),
  ],
);

export const announcements = pgTable(
  "announcements",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull(),
    subject: text("subject").notNull(),
    category: text("category"),
    details: text("details"),
    attachmentUrl: text("attachment_url"),
    dedupeKey: text("dedupe_key").notNull(),
    createdAt: timestamps.createdAt,
  },
  (t) => [
    uniqueIndex("announcements_dedupe_uq").on(t.dedupeKey),
    index("announcements_company_date_idx").on(t.companyId, t.publishedAt),
  ],
);

export const signals = pgTable(
  "signals",
  {
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    asOf: date("as_of").notNull(),
    kind: text("kind").notNull(),
    value: real("value").notNull(),
    inputs: jsonb("inputs").$type<Record<string, unknown>>().notNull(),
    modelVersion: smallint("model_version").notNull(),
    createdAt: timestamps.createdAt,
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.asOf, t.kind] }),
    index("signals_kind_asof_idx").on(t.kind, t.asOf),
  ],
);

export const ingestRuns = pgTable(
  "ingest_runs",
  {
    id: serial("id").primaryKey(),
    source: text("source").notNull(),
    status: ingestStatus("status").notNull().default("running"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    stats: jsonb("stats").$type<Record<string, number>>().notNull().default(sql`'{}'::jsonb`),
    error: text("error"),
  },
  (t) => [index("ingest_runs_source_started_idx").on(t.source, t.startedAt)],
);
