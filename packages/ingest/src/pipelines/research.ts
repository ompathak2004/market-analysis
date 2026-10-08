import { assertTimeLeft, isoDate, NotFoundError, sha256 } from "@ma/core";
import {
  analystCalls,
  analystRatings,
  and,
  companies,
  companyFacts,
  consensusHistory,
  desc,
  earningsEstimates,
  earningsSurprises,
  eq,
  isNull,
  priceTargets,
  shareholding,
  sql,
} from "@ma/db";
import type { IngestContext } from "../context.js";
import {
  MONEYCONTROL_PARSER_VERSION,
  type MoneycontrolEstimates,
  type MoneycontrolFacts,
  MoneycontrolSource,
  mergeSwot,
  parseMoneycontrolPage,
  parseSwotPage,
  trimMoneycontrolPage,
  trimSwotPage,
} from "../sources/moneycontrol.js";
import { type BrokerCall, upsertBrokerCalls } from "./analysts.js";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const PAGE_MAX_AGE_MS = 12 * HOUR_MS;
const SWOT_MAX_AGE_MS = 7 * DAY_MS;
const ESTIMATES_TTL_MS = 12 * HOUR_MS;
const REPORT_FAILURE_TTL_S = 24 * 3600;
const MAX_DISCOVERY_PAGES = 4;
const DISCOVERY_PAGE_RESERVE_MS = 15_000;

export interface MoneycontrolSyncResult {
  resolved: number;
  cards: number;
  inserted: number;
  quarters: number;
  estimates: number;
  surprises: number;
  consensus: number;
}

export async function syncMoneycontrol(
  ctx: IngestContext,
  companyId: number,
): Promise<MoneycontrolSyncResult | null> {
  const company = await ctx.db.query.companies.findFirst({ where: eq(companies.id, companyId) });
  if (!company?.nseSymbol) return null;
  const mc = new MoneycontrolSource(ctx.http);

  let code = company.moneycontrolCode;
  let pageUrl = company.moneycontrolUrl;
  let resolved = 0;
  if (!code || !pageUrl) {
    const match = await mc.resolve(company.nseSymbol, company.isin);
    if (!match) throw new NotFoundError("moneycontrol page", company.nseSymbol);
    code = match.code;
    pageUrl = match.url;
    resolved = 1;
    await ctx.db
      .update(companies)
      .set({ moneycontrolCode: code, moneycontrolUrl: pageUrl, updatedAt: new Date() })
      .where(eq(companies.id, companyId));
  }

  const { doc, changed } = await ctx.docs.fetch(pageUrl, {
    source: "moneycontrol",
    companyId,
    maxAgeMs: PAGE_MAX_AGE_MS,
    extract: trimMoneycontrolPage,
  });
  const page = parseMoneycontrolPage(doc.content);
  const pageCurrent =
    !changed && doc.status === "parsed" && doc.parserVersion === MONEYCONTROL_PARSER_VERSION;

  let cards = 0;
  let inserted = 0;
  let quarters = 0;
  if (!pageCurrent) {
    const swot = page.swotUrl ? await fetchSwot(ctx, page.swotUrl, companyId) : {};
    const facts: MoneycontrolFacts = {
      moneycontrolUrl: pageUrl,
      stockScore: page.stockScore?.score ?? null,
      verdict: page.stockScore?.verdict ?? null,
      teasers: page.teasers,
      swot: mergeSwot(page.swot, swot),
      registeredOffice: page.registeredOffice,
      management: page.management,
      website: page.website,
    };
    await ctx.db
      .insert(companyFacts)
      .values({
        companyId,
        source: "moneycontrol",
        parserVersion: MONEYCONTROL_PARSER_VERSION,
        facts: { ...facts },
        fetchedAt: doc.fetchedAt,
      })
      .onConflictDoUpdate({
        target: [companyFacts.companyId, companyFacts.source],
        set: {
          parserVersion: sql`excluded.parser_version`,
          facts: sql`excluded.facts`,
          fetchedAt: sql`excluded.fetched_at`,
        },
      });

    const city = page.registeredOffice?.city ?? null;
    if (city && city !== company.registeredCity) {
      await ctx.db
        .update(companies)
        .set({ registeredCity: city, updatedAt: new Date() })
        .where(eq(companies.id, companyId));
    }

    if (page.shareholding.trend.length) {
      await ctx.db
        .insert(shareholding)
        .values(
          page.shareholding.trend.map((p) => ({
            companyId,
            quarterEnd: p.quarterEnd,
            holder: p.holder,
            pct: p.pct,
            pledgePct: p.pledgePct,
            source: "moneycontrol",
            parserVersion: MONEYCONTROL_PARSER_VERSION,
          })),
        )
        .onConflictDoUpdate({
          target: [shareholding.companyId, shareholding.quarterEnd, shareholding.holder],
          set: {
            pct: sql`excluded.pct`,
            pledgePct: sql`excluded.pledge_pct`,
            parserVersion: sql`excluded.parser_version`,
            updatedAt: sql`now()`,
          },
        });
      quarters = new Set(page.shareholding.trend.map((p) => p.quarterEnd)).size;
    }

    const calls: BrokerCall[] = page.brokerCards.map((c) => ({
      companyId,
      nseSymbol: company.nseSymbol as string,
      broker: c.broker,
      publishedAt: c.publishedAt,
      rating: c.rating,
      targetPrice: c.targetPrice,
      priceAtCall: c.recoPrice,
      reportUrl: c.reportUrl,
      title: null,
      summary: null,
    }));
    cards = calls.length;
    if (calls.length) inserted = (await upsertBrokerCalls(ctx, calls, "moneycontrol")).inserted;
    await ctx.docs.markParsed(doc.id, MONEYCONTROL_PARSER_VERSION);
  }

  const est = await ctx.cache.getOrLoad<MoneycontrolEstimates>(
    `moneycontrol:estimates:${code}`,
    () => mc.estimates(code),
    { ttlMs: ESTIMATES_TTL_MS },
  );
  const written = est ? await writeEstimates(ctx, companyId, est) : null;

  return {
    resolved,
    cards,
    inserted,
    quarters,
    estimates: written?.estimates ?? 0,
    surprises: written?.surprises ?? 0,
    consensus: written?.consensus ?? 0,
  };
}

async function fetchSwot(ctx: IngestContext, url: string, companyId: number) {
  try {
    const { doc } = await ctx.docs.fetch(url, {
      source: "moneycontrol_swot",
      companyId,
      maxAgeMs: SWOT_MAX_AGE_MS,
      extract: trimSwotPage,
    });
    return parseSwotPage(doc.content);
  } catch (err) {
    ctx.logger.warn({ url, companyId, err }, "moneycontrol swot fetch failed");
    return {};
  }
}

async function writeEstimates(
  ctx: IngestContext,
  companyId: number,
  est: MoneycontrolEstimates,
): Promise<{ estimates: number; surprises: number; consensus: number }> {
  const asOf = isoDate(new Date());
  const version = MONEYCONTROL_PARSER_VERSION;
  const decimal = (v: number | null) => (v === null ? null : v.toFixed(2));

  if (est.rating) {
    await ctx.db
      .insert(analystRatings)
      .values({ companyId, asOf, ...est.rating, source: "moneycontrol", parserVersion: version })
      .onConflictDoUpdate({
        target: [analystRatings.companyId, analystRatings.asOf],
        set: {
          buyPct: sql`excluded.buy_pct`,
          outperformPct: sql`excluded.outperform_pct`,
          holdPct: sql`excluded.hold_pct`,
          underperformPct: sql`excluded.underperform_pct`,
          sellPct: sql`excluded.sell_pct`,
          analystCount: sql`excluded.analyst_count`,
          finalRating: sql`excluded.final_rating`,
          parserVersion: sql`excluded.parser_version`,
        },
      });
  }

  if (est.consensus.length) {
    await ctx.db
      .insert(consensusHistory)
      .values(
        est.consensus.map((c) => ({
          companyId,
          ...c,
          source: "moneycontrol",
          parserVersion: version,
        })),
      )
      .onConflictDoUpdate({
        target: [consensusHistory.companyId, consensusHistory.month],
        set: {
          buy: sql`excluded.buy`,
          outperform: sql`excluded.outperform`,
          hold: sql`excluded.hold`,
          underperform: sql`excluded.underperform`,
          sell: sql`excluded.sell`,
          parserVersion: sql`excluded.parser_version`,
        },
      });
  }

  if (est.estimates.length) {
    await ctx.db
      .insert(earningsEstimates)
      .values(
        est.estimates.map((e) => ({
          companyId,
          metric: e.metric,
          fiscalYearEnd: e.fiscalYearEnd,
          consolidated: true,
          asOf,
          low: decimal(e.low),
          avg: decimal(e.avg),
          high: decimal(e.high),
          actual: decimal(e.actual),
          source: "moneycontrol",
          parserVersion: version,
        })),
      )
      .onConflictDoUpdate({
        target: [
          earningsEstimates.companyId,
          earningsEstimates.metric,
          earningsEstimates.fiscalYearEnd,
          earningsEstimates.consolidated,
          earningsEstimates.asOf,
        ],
        set: {
          low: sql`excluded.low`,
          avg: sql`excluded.avg`,
          high: sql`excluded.high`,
          actual: sql`excluded.actual`,
          parserVersion: sql`excluded.parser_version`,
        },
      });
  }

  if (est.priceTarget) {
    await ctx.db
      .insert(priceTargets)
      .values({
        companyId,
        asOf,
        ...est.priceTarget,
        source: "moneycontrol",
        parserVersion: version,
      })
      .onConflictDoUpdate({
        target: [priceTargets.companyId, priceTargets.asOf],
        set: {
          low: sql`excluded.low`,
          mean: sql`excluded.mean`,
          high: sql`excluded.high`,
          parserVersion: sql`excluded.parser_version`,
        },
      });
  }

  if (est.surprises.length) {
    await ctx.db
      .insert(earningsSurprises)
      .values(
        est.surprises.map((s) => ({
          companyId,
          metric: s.metric,
          quarterEnd: s.quarterEnd,
          actual: decimal(s.actual),
          estimate: decimal(s.estimate),
          surprisePct: s.surprisePct,
          outcome: s.outcome,
          source: "moneycontrol",
          parserVersion: version,
        })),
      )
      .onConflictDoUpdate({
        target: [
          earningsSurprises.companyId,
          earningsSurprises.metric,
          earningsSurprises.quarterEnd,
        ],
        set: {
          actual: sql`excluded.actual`,
          estimate: sql`excluded.estimate`,
          surprisePct: sql`excluded.surprise_pct`,
          outcome: sql`excluded.outcome`,
          parserVersion: sql`excluded.parser_version`,
        },
      });
  }

  return {
    estimates: est.estimates.length,
    surprises: est.surprises.length,
    consensus: est.consensus.length,
  };
}

export interface BrokerReportsResult {
  fetched: number;
  linked: number;
  failed: number;
  skipped: number;
}

export async function fetchBrokerReports(
  ctx: IngestContext,
  limit: number,
  opts: { stop?: () => boolean } = {},
): Promise<BrokerReportsResult> {
  const queue = await pendingBrokerReports(ctx, limit, opts.stop);
  const out: BrokerReportsResult = { fetched: 0, linked: 0, failed: 0, skipped: 0 };
  for (const item of queue) {
    if (opts.stop?.()) {
      out.skipped++;
      continue;
    }
    try {
      const { doc } = await ctx.docs.fetch(item.url, {
        source: "broker_pdf",
        companyId: item.companyId,
        maxAgeMs: 30 * DAY_MS,
        pdfMaxPages: 12,
      });
      out.fetched++;
      const linked = await ctx.db
        .update(analystCalls)
        .set({ reportDocumentId: doc.id })
        .where(and(eq(analystCalls.reportUrl, item.url), isNull(analystCalls.reportDocumentId)))
        .returning({ id: analystCalls.id });
      out.linked += linked.length;
    } catch (err) {
      out.failed++;
      ctx.logger.warn({ url: item.url, err }, "broker report fetch failed");
      await ctx.redis.set(failureKey(item.url), "1", "EX", REPORT_FAILURE_TTL_S);
    }
  }
  return out;
}

async function pendingBrokerReports(
  ctx: IngestContext,
  limit: number,
  stop?: () => boolean,
): Promise<Array<{ url: string; companyId: number }>> {
  const pageSize = Math.max(limit * 4, 50);
  const queue: Array<{ url: string; companyId: number }> = [];
  for (let pageNo = 0; queue.length < limit && pageNo < MAX_DISCOVERY_PAGES; pageNo++) {
    if (stop?.()) break;
    assertTimeLeft(DISCOVERY_PAGE_RESERVE_MS);
    const page = await ctx.db
      .select({
        url: analystCalls.reportUrl,
        companyId: sql<number>`min(${analystCalls.companyId})`,
      })
      .from(analystCalls)
      .where(and(sql`${analystCalls.reportUrl} is not null`, isNull(analystCalls.reportDocumentId)))
      .groupBy(analystCalls.reportUrl)
      .orderBy(desc(sql`max(${analystCalls.publishedAt})`), analystCalls.reportUrl)
      .limit(pageSize)
      .offset(pageNo * pageSize);
    const urls = page.filter((p): p is typeof p & { url: string } => p.url !== null);
    const failed = urls.length ? await ctx.redis.mget(...urls.map((p) => failureKey(p.url))) : [];
    queue.push(...urls.filter((_, i) => !failed[i]));
    if (page.length < pageSize) break;
  }
  return queue.slice(0, limit);
}

function failureKey(url: string): string {
  return `broker-pdf:failed:${sha256(url).slice(0, 32)}`;
}
