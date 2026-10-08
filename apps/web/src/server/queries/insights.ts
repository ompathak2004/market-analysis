import { isoDate } from "@ma/core";
import { and, companies, desc, eq, insights, isNull } from "@ma/db";
import {
  assembleCompanyInputs,
  type BrokerDigest,
  brokerDigestSchema,
  brokersHash,
  type CompanyBrief,
  type CompanyInputs,
  companyBriefSchema,
  currentInsight,
  type Evidence,
  INSIGHT_MODEL_VERSION,
  inputHash,
  type MarketBrief,
  marketBriefSchema,
  type RuleInsight,
  type VerdictLabel,
} from "@ma/intel";
import type { AppContext } from "../context";
import { findCompany } from "./core";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const BRIEF_STALE_MS = 36 * HOUR;
const MARKET_STALE_MS = 18 * HOUR;

export interface InsightMeta {
  model: string;
  modelVersion: number;
  generatedAt: string;
  inputHash: string;
  stale: boolean;
}

export interface CompanyBriefView {
  symbol: string;
  asOf: string;
  brief: CompanyBrief | null;
  meta: InsightMeta | null;
  ruleInsights: RuleInsight[];
  evidence: Evidence[];
}

export interface BrokerDigestView {
  symbol: string;
  digest: BrokerDigest | null;
  meta: InsightMeta | null;
}

export interface CompanyInsightsView extends CompanyBriefView {
  digest: BrokerDigest | null;
  digestMeta: InsightMeta | null;
}

export interface FeedItem {
  symbol: string;
  name: string;
  sector: string | null;
  verdict: { score: number; label: VerdictLabel; confidence: number };
  previousScore: number | null;
  oneLiner: string;
  whatChanged: string;
  generatedAt: string;
  model: string;
}

export interface MarketBriefView {
  brief: MarketBrief | null;
  meta: (InsightMeta & { inputs: number }) | null;
  evidence: Evidence[];
}

type InsightRow = typeof insights.$inferSelect;

const metaOf = (row: InsightRow, stale: boolean): InsightMeta => ({
  model: row.model,
  modelVersion: row.modelVersion,
  generatedAt: row.generatedAt.toISOString(),
  inputHash: row.inputHash,
  stale,
});

const storedEvidence = (row: InsightRow): Evidence[] => {
  const ev = (row.inputs as { evidence?: unknown }).evidence;
  return Array.isArray(ev) ? (ev as Evidence[]) : [];
};

async function loadInputs(ctx: AppContext, companyId: number): Promise<CompanyInputs> {
  return assembleCompanyInputs(ctx.db, companyId, isoDate(new Date()));
}

export async function companyBrief(ctx: AppContext, symbol: string): Promise<CompanyBriefView> {
  const company = await findCompany(ctx, symbol);
  const view = await ctx.api.getOrLoad(
    `insights:brief:${company.nseSymbol}`,
    async (): Promise<CompanyBriefView> => {
      const [inputs, row] = await Promise.all([
        loadInputs(ctx, company.id),
        currentInsight(ctx.db, "company_brief", company.id),
      ]);
      const parsed = row ? companyBriefSchema.safeParse(row.output) : null;
      const brief = parsed?.success ? parsed.data : null;
      const stale =
        !!row &&
        (Date.now() - row.generatedAt.getTime() > BRIEF_STALE_MS ||
          row.inputHash !== inputHash(inputs) ||
          row.modelVersion !== INSIGHT_MODEL_VERSION);
      return {
        symbol: inputs.company.symbol,
        asOf: inputs.asOf,
        brief,
        meta: row && brief ? metaOf(row, stale) : null,
        ruleInsights: inputs.ruleInsights,
        evidence: row && brief ? storedEvidence(row) : inputs.evidence,
      };
    },
    { ttlMs: 10 * MINUTE, staleMs: HOUR },
  );
  return view as CompanyBriefView;
}

export async function brokerDigest(ctx: AppContext, symbol: string): Promise<BrokerDigestView> {
  const company = await findCompany(ctx, symbol);
  const view = await ctx.api.getOrLoad(
    `insights:digest:${company.nseSymbol}`,
    async (): Promise<BrokerDigestView> => {
      const [inputs, row] = await Promise.all([
        loadInputs(ctx, company.id),
        currentInsight(ctx.db, "broker_digest", company.id),
      ]);
      const parsed = row ? brokerDigestSchema.safeParse(row.output) : null;
      const digest = parsed?.success ? parsed.data : null;
      return {
        symbol: inputs.company.symbol,
        digest,
        meta: row && digest ? metaOf(row, row.inputHash !== brokersHash(inputs)) : null,
      };
    },
    { ttlMs: 10 * MINUTE, staleMs: HOUR },
  );
  return view as BrokerDigestView;
}

export async function companyInsights(
  ctx: AppContext,
  symbol: string,
): Promise<CompanyInsightsView> {
  const [brief, digest] = await Promise.all([companyBrief(ctx, symbol), brokerDigest(ctx, symbol)]);
  return { ...brief, digest: digest.digest, digestMeta: digest.meta };
}

export async function intelligenceFeed(ctx: AppContext, limit = 20): Promise<FeedItem[]> {
  const items = await ctx.api.getOrLoad(
    `feed:${limit}`,
    async (): Promise<FeedItem[]> => {
      const rows = await ctx.db
        .select({
          row: insights,
          symbol: companies.nseSymbol,
          name: companies.name,
          sector: companies.sector,
        })
        .from(insights)
        .innerJoin(companies, eq(companies.id, insights.companyId))
        .where(and(eq(insights.kind, "company_brief"), isNull(insights.supersededAt)))
        .orderBy(desc(insights.generatedAt))
        .limit(limit);
      return rows.flatMap(({ row, symbol, name, sector }) => {
        const parsed = companyBriefSchema.safeParse(row.output);
        if (!parsed.success) return [];
        const b = parsed.data;
        const prev = (row.inputs as { previousBrief?: { verdict?: { score?: unknown } } | null })
          .previousBrief?.verdict?.score;
        return [
          {
            symbol: symbol ?? name,
            name,
            sector: sector ?? null,
            verdict: {
              score: b.verdict.score,
              label: b.verdict.label,
              confidence: b.verdict.confidence,
            },
            previousScore: typeof prev === "number" ? prev : null,
            oneLiner: b.verdict.oneLiner,
            whatChanged: b.whatChanged[0] ?? b.thesis[0]?.point ?? b.verdict.oneLiner,
            generatedAt: row.generatedAt.toISOString(),
            model: row.model,
          },
        ];
      });
    },
    { ttlMs: 5 * MINUTE, staleMs: 30 * MINUTE },
  );
  return items ?? [];
}

export async function marketBrief(ctx: AppContext): Promise<MarketBriefView> {
  const view = await ctx.api.getOrLoad(
    "market-brief:current",
    async (): Promise<MarketBriefView> => {
      const row = await currentInsight(ctx.db, "market_brief", null);
      const parsed = row ? marketBriefSchema.safeParse(row.output) : null;
      if (!row || !parsed?.success) return { brief: null, meta: null, evidence: [] };
      const evidence = storedEvidence(row);
      const stale = Date.now() - row.generatedAt.getTime() > MARKET_STALE_MS;
      return {
        brief: parsed.data,
        meta: { ...metaOf(row, stale), inputs: evidence.length },
        evidence,
      };
    },
    { ttlMs: 5 * MINUTE, staleMs: 30 * MINUTE },
  );
  return view as MarketBriefView;
}
