import { sha256 } from "@ma/core";
import { analystCalls, and, companies, desc, eq, inArray, lt } from "@ma/db";
import type { IngestContext } from "../context.js";
import {
  type BrokerCall,
  parseTrendlyneReports,
  trendlyneAllReportsUrl,
} from "../sources/trendlyne.js";

type Action = (typeof analystCalls.$inferInsert)["action"];

const RANK: Record<string, number> = {
  "strong sell": 0,
  sell: 1,
  reduce: 1,
  underperform: 1,
  hold: 2,
  neutral: 2,
  accumulate: 3,
  buy: 3,
  outperform: 3,
  "strong buy": 4,
};

export async function syncAnalystCalls(
  ctx: IngestContext,
  pages = 3,
): Promise<{ fetched: number; inserted: number }> {
  const calls: BrokerCall[] = [];
  for (let page = 1; page <= pages; page++) {
    const { doc } = await ctx.docs.fetch(trendlyneAllReportsUrl(page), {
      source: "trendlyne",
      maxAgeMs: 30 * 60_000,
    });
    calls.push(...parseTrendlyneReports(doc.content));
  }
  const symbols = [
    ...new Set(calls.map((c) => c.nseSymbol).filter((s): s is string => Boolean(s))),
  ];
  if (!symbols.length) return { fetched: calls.length, inserted: 0 };

  const known = await ctx.db
    .select({ id: companies.id, nseSymbol: companies.nseSymbol })
    .from(companies)
    .where(inArray(companies.nseSymbol, symbols));
  const idBySymbol = new Map(known.map((k) => [k.nseSymbol, k.id]));

  let inserted = 0;
  for (const call of calls) {
    const companyId = call.nseSymbol ? idBySymbol.get(call.nseSymbol) : undefined;
    if (!companyId) continue;
    const dedupeKey = sha256(
      `${call.nseSymbol}|${call.broker}|${call.publishedAt}|${call.rating}|${call.targetPrice ?? ""}`,
    );
    const prior = await ctx.db.query.analystCalls.findFirst({
      where: and(
        eq(analystCalls.companyId, companyId),
        eq(analystCalls.broker, call.broker),
        lt(analystCalls.publishedAt, call.publishedAt),
      ),
      orderBy: desc(analystCalls.publishedAt),
    });
    const res = await ctx.db
      .insert(analystCalls)
      .values({
        companyId,
        broker: call.broker,
        publishedAt: call.publishedAt,
        action: classifyAction(call, prior ?? null),
        rating: call.rating,
        priorRating: prior?.rating ?? null,
        targetPrice: call.targetPrice,
        priorTargetPrice: prior?.targetPrice ?? null,
        priceAtCall: call.priceAtCall,
        reportUrl: call.reportUrl,
        source: "trendlyne",
        dedupeKey,
      })
      .onConflictDoNothing()
      .returning({ id: analystCalls.id });
    inserted += res.length;
  }
  ctx.logger.info({ fetched: calls.length, inserted }, "analyst calls synced");
  return { fetched: calls.length, inserted };
}

export function classifyAction(
  call: Pick<BrokerCall, "rating" | "targetPrice">,
  prior: { rating: string; targetPrice: number | null } | null,
): Action {
  if (!prior) return "initiate";
  const now = RANK[call.rating.toLowerCase()];
  const before = RANK[prior.rating.toLowerCase()];
  if (now !== undefined && before !== undefined && now !== before)
    return now > before ? "upgrade" : "downgrade";
  if (
    call.targetPrice != null &&
    prior.targetPrice != null &&
    call.targetPrice !== prior.targetPrice
  ) {
    return call.targetPrice > prior.targetPrice ? "raise_target" : "lower_target";
  }
  return "maintain";
}
