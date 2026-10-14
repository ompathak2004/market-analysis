import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  check,
  date,
  doublePrecision,
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
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const timestamps = {
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
export const ingestRunKind = pgEnum("ingest_run_kind", ["legacy", "campaign"]);

export const LISTING_STATUSES = [
  "active",
  "suspended",
  "delisted",
  "placeholder",
  "unverified",
] as const;
export type ListingStatus = (typeof LISTING_STATUSES)[number];

export type AdjustmentStatus = "verified" | "provider_adjusted" | "missing" | "unverified";

export const PRICE_ADJUSTMENT_VERSION = 1;

export const PRICE_BASIS = {
  version: PRICE_ADJUSTMENT_VERSION,
  ohlc: "yahoo_split_adjusted",
  adjClose: "yahoo_split_and_dividend_adjusted",
  index: "price_return_level",
} as const;

const priceProvenance = {
  source: text("source").notNull().default("legacy_yahoo"),
  sourceSymbol: text("source_symbol"),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }),
  parserVersion: smallint("parser_version").notNull().default(0),
  adjustmentGeneration: integer("adjustment_generation").notNull().default(0),
  isFinal: boolean("is_final").notNull().default(false),
};

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
    moneycontrolCode: text("moneycontrol_code"),
    moneycontrolUrl: text("moneycontrol_url"),
    registeredCity: text("registered_city"),
    listedFrom: date("listed_from"),
    delistedOn: date("delisted_on"),
    listingStatus: text("listing_status").$type<ListingStatus>().notNull().default("unverified"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("companies_nse_symbol_uq").on(t.nseSymbol),
    uniqueIndex("companies_isin_uq").on(t.isin),
    index("companies_normalized_name_idx").on(t.normalizedName),
    check(
      "companies_listing_status_chk",
      sql`${t.listingStatus} in ('active','suspended','delisted','placeholder','unverified')`,
    ),
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
  (t) => [
    primaryKey({ columns: [t.companyId, t.alias] }),
    index("company_aliases_alias_idx").on(t.alias),
  ],
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
    ...priceProvenance,
    adjustmentStatus: text("adjustment_status")
      .$type<AdjustmentStatus>()
      .notNull()
      .default("unverified"),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.date] }),
    index("prices_daily_date_idx").on(t.date),
  ],
);

export const marketSymbols = pgTable(
  "market_symbols",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").references(() => companies.id, { onDelete: "cascade" }),
    indexId: integer("index_id").references(() => indices.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    symbol: text("symbol").notNull(),
    validFrom: date("valid_from").notNull(),
    validTo: date("valid_to"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    sourceDocumentRevisionId: bigint("source_document_revision_id", { mode: "number" }),
    createdAt: timestamps.createdAt,
  },
  (t) => [
    unique("market_symbols_provider_symbol_from").on(t.provider, t.symbol, t.validFrom),
    index("market_symbols_company_idx").on(t.companyId),
    index("market_symbols_index_idx").on(t.indexId),
    check("market_symbols_one_owner", sql`num_nonnulls(${t.companyId}, ${t.indexId}) = 1`),
    check("market_symbols_range", sql`${t.validTo} is null or ${t.validTo} > ${t.validFrom}`),
  ],
);

export const tradingSessions = pgTable(
  "trading_sessions",
  {
    exchange: text("exchange").notNull(),
    date: date("date").notNull(),
    opensAt: timestamp("opens_at", { withTimezone: true }),
    closesAt: timestamp("closes_at", { withTimezone: true }),
    sessionType: text("session_type").notNull().default("regular"),
    source: text("source").notNull(),
    sourceUrl: text("source_url"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.exchange, t.date] })],
);

export type PriceQualityStatus =
  | "pending"
  | "partial"
  | "complete"
  | "exception"
  | "rebuild_required";

export type PriceSeriesException =
  | "no_yahoo_symbol"
  | "not_in_nse_equity_list"
  | "isin_mismatch"
  | "listing_source_unavailable"
  | "identity_mismatch";

export const priceSeriesState = pgTable(
  "price_series_state",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id")
      .unique()
      .references(() => companies.id, { onDelete: "cascade" }),
    indexId: integer("index_id")
      .unique()
      .references(() => indices.id, { onDelete: "cascade" }),
    desiredFrom: date("desired_from").notNull(),
    desiredTo: date("desired_to").notNull(),
    verifiedThrough: date("verified_through"),
    adjustmentGeneration: integer("adjustment_generation").notNull().default(0),
    actionHash: text("action_hash"),
    qualityStatus: text("quality_status").$type<PriceQualityStatus>().notNull().default("pending"),
    exceptionReason: text("exception_reason").$type<PriceSeriesException>(),
    detail: text("detail"),
    checkedAt: timestamp("checked_at", { withTimezone: true }),
    updatedAt: timestamps.updatedAt,
  },
  (t) => [
    check("price_series_state_one_owner", sql`num_nonnulls(${t.companyId}, ${t.indexId}) = 1`),
    check("price_series_state_range", sql`${t.desiredFrom} <= ${t.desiredTo}`),
  ],
);

export const priceManifests = pgTable("price_manifests", {
  id: serial("id").primaryKey(),
  kind: text("kind").notNull(),
  desiredFrom: date("desired_from").notNull(),
  desiredTo: date("desired_to").notNull(),
  companies: integer("companies").notNull(),
  units: integer("units").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const priceManifestCompanies = pgTable(
  "price_manifest_companies",
  {
    manifestId: integer("manifest_id")
      .notNull()
      .references(() => priceManifests.id, { onDelete: "cascade" }),
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    seriesId: integer("series_id").references(() => priceSeriesState.id, { onDelete: "set null" }),
    symbol: text("symbol"),
    units: integer("units").notNull().default(0),
    exceptionReason: text("exception_reason").$type<PriceSeriesException>(),
  },
  (t) => [primaryKey({ columns: [t.manifestId, t.companyId] })],
);

export type PriceGapReason =
  | "missing_source_data"
  | "prelisting"
  | "suspension"
  | "delisted"
  | "placeholder"
  | "unresolved_identity"
  | "invalid_bars";

export type PriceGapStatus = "open" | "exempt" | "resolved";

export const priceGaps = pgTable(
  "price_gaps",
  {
    seriesId: integer("series_id")
      .notNull()
      .references(() => priceSeriesState.id, { onDelete: "cascade" }),
    fromDate: date("from_date").notNull(),
    toDate: date("to_date").notNull(),
    reason: text("reason").$type<PriceGapReason>().notNull(),
    status: text("status").$type<PriceGapStatus>().notNull().default("open"),
    sessions: integer("sessions").notNull().default(0),
    checks: integer("checks").notNull().default(0),
    nextCheckAt: timestamp("next_check_at", { withTimezone: true }),
    evidenceRevisionId: bigint("evidence_revision_id", { mode: "number" }),
    detail: text("detail"),
    ...timestamps,
  },
  (t) => [
    primaryKey({ columns: [t.seriesId, t.fromDate, t.toDate] }),
    index("price_gaps_due_idx").on(t.status, t.nextCheckAt),
    check("price_gaps_range", sql`${t.fromDate} <= ${t.toDate}`),
  ],
);

export type CorporateActionType = "split" | "bonus" | "dividend";

export const corporateActions = pgTable(
  "corporate_actions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    actionType: text("action_type").$type<CorporateActionType>().notNull(),
    exDate: date("ex_date").notNull(),
    eventKey: text("event_key").notNull(),
    splitNumerator: doublePrecision("split_numerator"),
    splitDenominator: doublePrecision("split_denominator"),
    cashAmount: doublePrecision("cash_amount"),
    currency: text("currency"),
    source: text("source").notNull(),
    sourceRevisionId: bigint("source_revision_id", { mode: "number" }),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
    correctedAt: timestamp("corrected_at", { withTimezone: true }),
  },
  (t) => [
    unique("corporate_actions_company_event").on(t.companyId, t.eventKey),
    index("corporate_actions_ex_date_idx").on(t.exDate),
    check(
      "corporate_actions_split_ratio",
      sql`${t.actionType} = 'dividend' or (${t.splitNumerator} > 0 and ${t.splitDenominator} > 0)`,
    ),
    check("corporate_actions_cash", sql`${t.cashAmount} is null or ${t.cashAmount} >= 0`),
  ],
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
    content: text("content"),
    status: documentStatus("status").notNull().default("fetched"),
    parserVersion: smallint("parser_version"),
    textParserVersion: smallint("text_parser_version").notNull().default(0),
    currentRevisionId: bigint("current_revision_id", { mode: "number" }),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
    parsedAt: timestamp("parsed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("documents_url_uq").on(t.url),
    index("documents_sha256_idx").on(t.sha256),
    index("documents_company_source_idx").on(t.companyId, t.source),
    index("documents_inline_idx").on(t.source, t.id).where(sql`${t.content} is not null`),
  ],
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
    sourceDocumentId: integer("source_document_id").references(() => documents.id, {
      onDelete: "set null",
    }),
    title: text("title"),
    summary: text("summary"),
    reportDocumentId: integer("report_document_id").references(() => documents.id, {
      onDelete: "set null",
    }),
    thesis: jsonb("thesis").$type<Record<string, unknown>>(),
    summaryModelVersion: smallint("summary_model_version"),
    summarizedAt: timestamp("summarized_at", { withTimezone: true }),
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
    materiality: text("materiality"),
    triageCategory: text("triage_category"),
    soWhat: text("so_what"),
    triageModelVersion: smallint("triage_model_version"),
    categoryKey: text("category_key"),
    retentionClass: text("retention_class"),
    retainUntil: date("retain_until"),
    policyVersion: smallint("policy_version").notNull().default(0),
    createdAt: timestamps.createdAt,
  },
  (t) => [
    uniqueIndex("announcements_dedupe_uq").on(t.dedupeKey),
    index("announcements_published_idx").on(t.publishedAt),
    index("announcements_company_date_idx").on(t.companyId, t.publishedAt),
    index("announcements_retention_idx").on(t.retentionClass, t.retainUntil),
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
    primaryKey({ columns: [t.companyId, t.asOf, t.kind, t.modelVersion] }),
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
    kind: ingestRunKind("kind").notNull().default("legacy"),
    childrenTotal: integer("children_total").notNull().default(0),
    childrenDone: integer("children_done").notNull().default(0),
    childrenFailed: integer("children_failed").notNull().default(0),
    parentJobId: text("parent_job_id"),
  },
  (t) => [
    index("ingest_runs_source_started_idx").on(t.source, t.startedAt),
    uniqueIndex("ingest_runs_parent_job_idx").on(t.parentJobId),
  ],
);

export const companySync = pgTable(
  "company_sync",
  {
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    job: text("job").notNull(),
    syncedAt: timestamp("synced_at", { withTimezone: true }),
    attemptedAt: timestamp("attempted_at", { withTimezone: true }),
    failures: smallint("failures").notNull().default(0),
    error: text("error"),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.job] }),
    index("company_sync_job_synced_idx").on(t.job, t.syncedAt),
  ],
);

export const indexPricesDaily = pgTable(
  "index_prices_daily",
  {
    indexId: integer("index_id")
      .notNull()
      .references(() => indices.id, { onDelete: "cascade" }),
    date: date("date").notNull(),
    open: real("open"),
    high: real("high"),
    low: real("low"),
    close: real("close").notNull(),
    volume: bigint("volume", { mode: "number" }),
    ...priceProvenance,
  },
  (t) => [primaryKey({ columns: [t.indexId, t.date] })],
);

export const holder = pgEnum("holder", ["promoter", "fii", "dii", "public", "others"]);
export const estimateMetric = pgEnum("estimate_metric", ["eps", "net_profit", "revenue"]);

export const shareholding = pgTable(
  "shareholding",
  {
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    quarterEnd: date("quarter_end").notNull(),
    holder: holder("holder").notNull(),
    pct: real("pct").notNull(),
    pledgePct: real("pledge_pct"),
    source: text("source").notNull().default("moneycontrol"),
    parserVersion: smallint("parser_version").notNull(),
    updatedAt: timestamps.updatedAt,
  },
  (t) => [primaryKey({ columns: [t.companyId, t.quarterEnd, t.holder] })],
);

export const analystRatings = pgTable(
  "analyst_ratings",
  {
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    asOf: date("as_of").notNull(),
    buyPct: real("buy_pct"),
    outperformPct: real("outperform_pct"),
    holdPct: real("hold_pct"),
    underperformPct: real("underperform_pct"),
    sellPct: real("sell_pct"),
    analystCount: smallint("analyst_count"),
    finalRating: text("final_rating"),
    source: text("source").notNull().default("moneycontrol"),
    parserVersion: smallint("parser_version").notNull(),
  },
  (t) => [primaryKey({ columns: [t.companyId, t.asOf] })],
);

export const consensusHistory = pgTable(
  "consensus_history",
  {
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    month: date("month").notNull(),
    buy: smallint("buy"),
    outperform: smallint("outperform"),
    hold: smallint("hold"),
    underperform: smallint("underperform"),
    sell: smallint("sell"),
    source: text("source").notNull().default("moneycontrol"),
    parserVersion: smallint("parser_version").notNull(),
  },
  (t) => [primaryKey({ columns: [t.companyId, t.month] })],
);

export const earningsEstimates = pgTable(
  "earnings_estimates",
  {
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    metric: estimateMetric("metric").notNull(),
    fiscalYearEnd: date("fiscal_year_end").notNull(),
    consolidated: boolean("consolidated").notNull().default(true),
    asOf: date("as_of").notNull(),
    low: numeric("low", { precision: 18, scale: 2 }),
    high: numeric("high", { precision: 18, scale: 2 }),
    avg: numeric("avg", { precision: 18, scale: 2 }),
    actual: numeric("actual", { precision: 18, scale: 2 }),
    source: text("source").notNull().default("moneycontrol"),
    parserVersion: smallint("parser_version").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.metric, t.fiscalYearEnd, t.consolidated, t.asOf] }),
  ],
);

export const priceTargets = pgTable(
  "price_targets",
  {
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    asOf: date("as_of").notNull(),
    low: real("low"),
    mean: real("mean"),
    high: real("high"),
    source: text("source").notNull().default("moneycontrol"),
    parserVersion: smallint("parser_version").notNull(),
  },
  (t) => [primaryKey({ columns: [t.companyId, t.asOf] })],
);

export const earningsSurprises = pgTable(
  "earnings_surprises",
  {
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    metric: estimateMetric("metric").notNull(),
    quarterEnd: date("quarter_end").notNull(),
    actual: numeric("actual", { precision: 18, scale: 2 }),
    estimate: numeric("estimate", { precision: 18, scale: 2 }),
    surprisePct: real("surprise_pct"),
    outcome: text("outcome").notNull(),
    source: text("source").notNull().default("moneycontrol"),
    parserVersion: smallint("parser_version").notNull(),
  },
  (t) => [primaryKey({ columns: [t.companyId, t.metric, t.quarterEnd] })],
);

export const companyFacts = pgTable(
  "company_facts",
  {
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    source: text("source").notNull(),
    parserVersion: smallint("parser_version").notNull(),
    facts: jsonb("facts").$type<Record<string, unknown>>().notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.companyId, t.source] })],
);

export const insights = pgTable(
  "insights",
  {
    id: serial("id").primaryKey(),
    companyId: integer("company_id").references(() => companies.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    subjectId: integer("subject_id"),
    modelVersion: smallint("model_version").notNull(),
    model: text("model").notNull(),
    inputHash: text("input_hash").notNull(),
    inputs: jsonb("inputs").$type<Record<string, unknown>>().notNull(),
    output: jsonb("output").$type<Record<string, unknown>>().notNull(),
    confidence: real("confidence"),
    promptTokens: integer("prompt_tokens"),
    completionTokens: integer("completion_tokens"),
    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
  },
  (t) => [
    unique("insights_key_uq")
      .on(t.companyId, t.kind, t.subjectId, t.modelVersion, t.inputHash)
      .nullsNotDistinct(),
    index("insights_current_idx").on(t.kind, t.companyId, t.generatedAt),
  ],
);

export const llmUsage = pgTable(
  "llm_usage",
  {
    id: serial("id").primaryKey(),
    kind: text("kind").notNull(),
    model: text("model").notNull(),
    promptTokens: integer("prompt_tokens").notNull(),
    completionTokens: integer("completion_tokens").notNull(),
    latencyMs: integer("latency_ms").notNull(),
    ok: boolean("ok").notNull(),
    createdAt: timestamps.createdAt,
  },
  (t) => [index("llm_usage_created_idx").on(t.createdAt)],
);

export const aircraftTier = pgEnum("aircraft_tier", ["registry", "press", "inferred", "manual"]);
export const aircraftLinkBasis = pgEnum("aircraft_link_basis", [
  "owner",
  "subsidiary",
  "promoter_group",
  "charter",
]);
export const flightCompleteness = pgEnum("flight_completeness", [
  "full",
  "departure_only",
  "arrival_only",
  "enroute",
]);

export const corporateAircraft = pgTable(
  "corporate_aircraft",
  {
    id: serial("id").primaryKey(),
    registration: text("registration").notNull().unique(),
    icaoHex: text("icao_hex").notNull().unique(),
    icaoType: text("icao_type"),
    model: text("model"),
    ownerName: text("owner_name"),
    operatorName: text("operator_name"),
    groupName: text("group_name"),
    linkedPerson: text("linked_person"),
    linkedRole: text("linked_role"),
    tier: aircraftTier("tier").notNull(),
    confidence: real("confidence").notNull(),
    privacyFlagged: boolean("privacy_flagged").notNull().default(false),
    active: boolean("active").notNull().default(true),
    homeIcao: text("home_icao"),
    sourceUrl: text("source_url"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index("corporate_aircraft_active_idx").on(t.active)],
);

export const corporateAircraftCompanies = pgTable(
  "corporate_aircraft_companies",
  {
    aircraftId: integer("aircraft_id")
      .notNull()
      .references(() => corporateAircraft.id, { onDelete: "cascade" }),
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    basis: aircraftLinkBasis("basis").notNull(),
  },
  (t) => [primaryKey({ columns: [t.aircraftId, t.companyId] })],
);

export const aircraftPositions = pgTable(
  "aircraft_positions",
  {
    hex: text("hex").notNull(),
    ts: timestamp("ts", { withTimezone: true }).notNull(),
    lat: real("lat"),
    lon: real("lon"),
    altFt: integer("alt_ft"),
    gsKt: real("gs_kt"),
    track: real("track"),
    onGround: boolean("on_ground").notNull(),
    squawk: text("squawk"),
    source: text("source").notNull().default("adsb_lol"),
  },
  (t) => [primaryKey({ columns: [t.hex, t.ts] }), index("aircraft_positions_ts_idx").on(t.ts)],
);

export const aircraftFlights = pgTable(
  "aircraft_flights",
  {
    id: serial("id").primaryKey(),
    aircraftId: integer("aircraft_id")
      .notNull()
      .references(() => corporateAircraft.id, { onDelete: "cascade" }),
    hex: text("hex").notNull(),
    departedAt: timestamp("departed_at", { withTimezone: true }),
    arrivedAt: timestamp("arrived_at", { withTimezone: true }),
    durationMin: integer("duration_min"),
    depIcao: text("dep_icao"),
    depCity: text("dep_city"),
    depCountry: text("dep_country"),
    arrIcao: text("arr_icao"),
    arrCity: text("arr_city"),
    arrCountry: text("arr_country"),
    completeness: flightCompleteness("completeness").notNull(),
    source: text("source").notNull(),
    samples: integer("samples").notNull().default(0),
    maxAltFt: integer("max_alt_ft"),
    dedupeKey: text("dedupe_key").notNull().unique(),
    ...timestamps,
  },
  (t) => [index("aircraft_flights_aircraft_departed_idx").on(t.aircraftId, t.departedAt)],
);

export const facilityKind = pgEnum("facility_kind", [
  "hq",
  "refinery",
  "spm",
  "port",
  "terminal",
  "lng_terminal",
  "plant",
  "mine",
  "sez",
  "power_plant",
  "jetty",
]);
export const facilityRole = pgEnum("facility_role", ["owner", "operator", "user"]);
export const vesselClass = pgEnum("vessel_class", [
  "tanker",
  "gas",
  "cargo",
  "container",
  "passenger",
  "other",
]);

export const facilities = pgTable(
  "facilities",
  {
    id: serial("id").primaryKey(),
    slug: text("slug").notNull().unique(),
    name: text("name").notNull(),
    kind: facilityKind("kind").notNull(),
    lat: real("lat").notNull(),
    lon: real("lon").notNull(),
    radiusKm: real("radius_km").notNull(),
    country: text("country").notNull().default("IN"),
    locode: text("locode"),
    aliases: text("aliases").array().notNull().default(sql`'{}'::text[]`),
    exclusive: boolean("exclusive").notNull().default(false),
    active: boolean("active").notNull().default(true),
    sourceUrl: text("source_url"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index("facilities_kind_idx").on(t.kind)],
);

export const facilityCompanies = pgTable(
  "facility_companies",
  {
    facilityId: integer("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "cascade" }),
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    role: facilityRole("role").notNull(),
    commodityIn: text("commodity_in").array().notNull().default(sql`'{}'::text[]`),
    commodityOut: text("commodity_out").array().notNull().default(sql`'{}'::text[]`),
    note: text("note"),
  },
  (t) => [primaryKey({ columns: [t.facilityId, t.companyId] })],
);

export const vessels = pgTable(
  "vessels",
  {
    mmsi: integer("mmsi").primaryKey(),
    imo: integer("imo"),
    name: text("name"),
    callSign: text("call_sign"),
    flag: text("flag"),
    shipType: smallint("ship_type"),
    class: vesselClass("class").notNull().default("other"),
    lengthM: smallint("length_m"),
    beamM: smallint("beam_m"),
    draughtM: real("draught_m"),
    sizeClass: text("size_class"),
    dwtEst: integer("dwt_est"),
    dwt: integer("dwt"),
    destinationRaw: text("destination_raw"),
    destinationFacilityId: integer("destination_facility_id").references(() => facilities.id, {
      onDelete: "set null",
    }),
    etaRaw: text("eta_raw"),
    ownerCompanyId: integer("owner_company_id").references(() => companies.id, {
      onDelete: "set null",
    }),
    ownerSourceUrl: text("owner_source_url"),
    staticUpdatedAt: timestamp("static_updated_at", { withTimezone: true }),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("vessels_imo_idx").on(t.imo),
    index("vessels_destination_facility_idx").on(t.destinationFacilityId),
  ],
);

export const vesselPositions = pgTable(
  "vessel_positions",
  {
    mmsi: integer("mmsi").notNull(),
    ts: timestamp("ts", { withTimezone: true }).notNull(),
    lat: real("lat").notNull(),
    lon: real("lon").notNull(),
    sogKt: real("sog_kt"),
    cogDeg: real("cog_deg"),
    headingDeg: smallint("heading_deg"),
    navStatus: smallint("nav_status"),
  },
  (t) => [primaryKey({ columns: [t.mmsi, t.ts] }), index("vessel_positions_ts_idx").on(t.ts)],
);

export const vesselCalls = pgTable(
  "vessel_calls",
  {
    id: serial("id").primaryKey(),
    mmsi: integer("mmsi")
      .notNull()
      .references(() => vessels.mmsi, { onDelete: "cascade" }),
    facilityId: integer("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "cascade" }),
    enteredAt: timestamp("entered_at", { withTimezone: true }).notNull(),
    leftAt: timestamp("left_at", { withTimezone: true }),
    dwellMin: integer("dwell_min"),
    draughtIn: real("draught_in"),
    draughtOut: real("draught_out"),
    cargoDirection: text("cargo_direction"),
    navStatusMode: smallint("nav_status_mode"),
    positions: integer("positions").notNull().default(0),
    endedBy: text("ended_by"),
  },
  (t) => [
    uniqueIndex("vessel_calls_uq").on(t.mmsi, t.facilityId, t.enteredAt),
    index("vessel_calls_facility_entered_idx").on(t.facilityId, t.enteredAt),
  ],
);

export const chokepointTransits = pgTable(
  "chokepoint_transits",
  {
    id: serial("id").primaryKey(),
    mmsi: integer("mmsi")
      .notNull()
      .references(() => vessels.mmsi, { onDelete: "cascade" }),
    chokepoint: text("chokepoint").notNull(),
    enteredAt: timestamp("entered_at", { withTimezone: true }).notNull(),
    leftAt: timestamp("left_at", { withTimezone: true }),
    loiterMin: integer("loiter_min").notNull().default(0),
    minSogKt: real("min_sog_kt"),
    destinationAtEntry: text("destination_at_entry"),
    destinationFacilityId: integer("destination_facility_id").references(() => facilities.id, {
      onDelete: "set null",
    }),
    direction: text("direction"),
    endedBy: text("ended_by"),
  },
  (t) => [
    uniqueIndex("chokepoint_transits_uq").on(t.mmsi, t.chokepoint, t.enteredAt),
    index("chokepoint_transits_cp_entered_idx").on(t.chokepoint, t.enteredAt),
  ],
);

export const vesselFleet = pgTable(
  "vessel_fleet",
  {
    imo: integer("imo").primaryKey(),
    name: text("name").notNull(),
    dwt: integer("dwt"),
    type: text("type"),
    companyId: integer("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    sourceUrl: text("source_url").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("vessel_fleet_company_idx").on(t.companyId)],
);

export const altdataEvents = pgTable(
  "altdata_events",
  {
    id: serial("id").primaryKey(),
    layer: text("layer").notNull(),
    kind: text("kind").notNull(),
    companyId: integer("company_id").references(() => companies.id, { onDelete: "set null" }),
    facilityId: integer("facility_id").references(() => facilities.id, { onDelete: "set null" }),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    headline: text("headline").notNull(),
    detail: jsonb("detail").$type<Record<string, unknown>>().notNull(),
    severity: smallint("severity").notNull().default(1),
    dedupeKey: text("dedupe_key").notNull().unique(),
    createdAt: timestamps.createdAt,
  },
  (t) => [
    index("altdata_events_occurred_idx").on(t.occurredAt),
    index("altdata_events_company_occurred_idx").on(t.companyId, t.occurredAt),
  ],
);

export const altdataCoverage = pgTable(
  "altdata_coverage",
  {
    layer: text("layer").notNull(),
    zone: text("zone").notNull(),
    day: date("day").notNull(),
    windows: integer("windows").notNull().default(0),
    windowsWithData: integer("windows_with_data").notNull().default(0),
    messages: integer("messages").notNull().default(0),
    uniqueIds: integer("unique_ids").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.layer, t.zone, t.day] })],
);

export const jobStatus = pgEnum("job_status", [
  "queued",
  "running",
  "succeeded",
  "failed",
  "dead",
  "deferred",
  "abandoned",
]);
export const jobMode = pgEnum("job_mode", ["paused", "worker"]);

export const jobRuns = pgTable(
  "job_runs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    jobType: text("job_type").notNull(),
    unitKey: text("unit_key").notNull(),
    campaignId: integer("campaign_id").references(() => ingestRuns.id, { onDelete: "cascade" }),
    status: jobStatus("status").notNull().default("queued"),
    attempt: integer("attempt").notNull().default(0),
    lane: text("lane").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    startedAt: timestamp("started_at", { withTimezone: true }),
    deadlineAt: timestamp("deadline_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    error: text("error"),
    metrics: jsonb("metrics").$type<Record<string, number>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamps.createdAt,
  },
  (t) => [
    unique("job_runs_unit_key").on(t.jobType, t.unitKey, t.campaignId).nullsNotDistinct(),
    index("job_runs_status_created_idx").on(t.status, t.createdAt),
    index("job_runs_campaign_status_idx").on(t.campaignId, t.status),
  ],
);

export const jobAttempts = pgTable(
  "job_attempts",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    runId: bigint("run_id", { mode: "number" })
      .notNull()
      .references(() => jobRuns.id, { onDelete: "cascade" }),
    attempt: integer("attempt").notNull(),
    queueJobId: uuid("queue_job_id"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    outcome: jobStatus("outcome").notNull().default("running"),
    error: text("error"),
    workerOwner: uuid("worker_owner"),
    generation: bigint("generation", { mode: "number" }),
  },
  (t) => [
    index("job_attempts_run_idx").on(t.runId),
    index("job_attempts_started_idx").on(t.startedAt),
  ],
);

export const jobDailyStats = pgTable(
  "job_daily_stats",
  {
    day: date("day").notNull(),
    jobType: text("job_type").notNull(),
    succeeded: integer("succeeded").notNull().default(0),
    failed: integer("failed").notNull().default(0),
    dead: integer("dead").notNull().default(0),
    deferred: integer("deferred").notNull().default(0),
    abandoned: integer("abandoned").notNull().default(0),
    durationMsTotal: bigint("duration_ms_total", { mode: "number" }).notNull().default(0),
    durationMsMax: integer("duration_ms_max").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.day, t.jobType] })],
);

export const workerLeases = pgTable("worker_leases", {
  name: text("name").primaryKey(),
  ownerId: uuid("owner_id").notNull(),
  generation: bigint("generation", { mode: "number" }).notNull().default(1),
  leasedUntil: timestamp("leased_until", { withTimezone: true }).notNull(),
  heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }).notNull().defaultNow(),
});

export const jobControl = pgTable(
  "job_control",
  {
    id: smallint("id").primaryKey().default(1),
    mode: jobMode("mode").notNull().default("paused"),
    updatedAt: timestamps.updatedAt,
  },
  (t) => [check("job_control_singleton", sql`${t.id} = 1`)],
);

export const opsAlerts = pgTable(
  "ops_alerts",
  {
    id: serial("id").primaryKey(),
    kind: text("kind").notNull(),
    key: text("key").notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  },
  (t) => [unique("ops_alerts_kind_key").on(t.kind, t.key)],
);
