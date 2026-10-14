import { sha256 } from "@ma/core";
import { analystCalls, and, type Db, desc, eq, lt, sql, type Tx } from "@ma/db";

type Action = (typeof analystCalls.$inferInsert)["action"];

export interface BrokerCall {
  companyId: number;
  nseSymbol: string;
  broker: string;
  publishedAt: string;
  rating: string;
  targetPrice: number | null;
  priceAtCall: number | null;
  reportUrl: string | null;
  title: string | null;
  summary: string | null;
}

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

export async function upsertBrokerCalls(
  db: Db | Tx,
  calls: BrokerCall[],
  source: string,
): Promise<{ inserted: number; ids: number[] }> {
  const ordered = [...calls].sort((a, b) => a.publishedAt.localeCompare(b.publishedAt));
  let inserted = 0;
  const ids: number[] = [];
  for (const call of ordered) {
    const dedupeKey = sha256(
      `${call.nseSymbol}|${call.broker}|${call.publishedAt}|${call.rating}|${call.targetPrice ?? ""}`,
    );
    const prior = await db.query.analystCalls.findFirst({
      where: and(
        eq(analystCalls.companyId, call.companyId),
        eq(analystCalls.broker, call.broker),
        lt(analystCalls.publishedAt, call.publishedAt),
      ),
      orderBy: desc(analystCalls.publishedAt),
    });
    const res = await db
      .insert(analystCalls)
      .values({
        companyId: call.companyId,
        broker: call.broker,
        publishedAt: call.publishedAt,
        action: classifyAction(call, prior ?? null),
        rating: call.rating,
        priorRating: prior?.rating ?? null,
        targetPrice: call.targetPrice,
        priorTargetPrice: prior?.targetPrice ?? null,
        priceAtCall: call.priceAtCall,
        reportUrl: call.reportUrl,
        title: call.title,
        summary: call.summary,
        source,
        dedupeKey,
      })
      .onConflictDoUpdate({
        target: analystCalls.dedupeKey,
        set: {
          action: sql`excluded.action`,
          priorRating: sql`excluded.prior_rating`,
          priorTargetPrice: sql`excluded.prior_target_price`,
          reportUrl: sql`excluded.report_url`,
          title: sql`coalesce(excluded.title, ${analystCalls.title})`,
          summary: sql`coalesce(excluded.summary, ${analystCalls.summary})`,
        },
      })
      .returning({ id: analystCalls.id, inserted: sql<boolean>`(xmax = 0)` });
    for (const r of res) {
      ids.push(r.id);
      if (r.inserted) inserted++;
    }
  }
  return { inserted, ids };
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
