import { chunk, sha256 } from "@ma/core";
import { announcements, companies, eq, pricesDaily, sql } from "@ma/db";
import type { IngestContext } from "../context.js";
import type { YahooRange } from "../sources/yahoo.js";

export async function syncPrices(
  ctx: IngestContext,
  companyId: number,
  range: YahooRange = "1y",
): Promise<number> {
  const company = await ctx.db.query.companies.findFirst({ where: eq(companies.id, companyId) });
  if (!company?.yahooSymbol) return 0;
  const bars = await ctx.yahoo.dailyBars(company.yahooSymbol, range);
  if (!bars.length) return 0;
  for (const batch of chunk(bars, 500)) {
    await ctx.db
      .insert(pricesDaily)
      .values(batch.map((b) => ({ companyId, ...b })))
      .onConflictDoUpdate({
        target: [pricesDaily.companyId, pricesDaily.date],
        set: {
          open: sql`excluded.open`,
          high: sql`excluded.high`,
          low: sql`excluded.low`,
          close: sql`excluded.close`,
          adjClose: sql`excluded.adj_close`,
          volume: sql`excluded.volume`,
        },
      });
  }
  return bars.length;
}

export async function syncAnnouncements(ctx: IngestContext, companyId: number): Promise<number> {
  const company = await ctx.db.query.companies.findFirst({ where: eq(companies.id, companyId) });
  if (!company?.nseSymbol) return 0;
  const items = await ctx.nse.announcements(company.nseSymbol);
  if (!items.length) return 0;
  const rows = items.map((a) => ({
    companyId,
    publishedAt: a.publishedAt,
    subject: a.subject,
    category: a.subject,
    details: a.details || null,
    attachmentUrl: a.attachmentUrl,
    dedupeKey: sha256(
      `${company.nseSymbol}|${a.publishedAt.toISOString()}|${a.subject}|${a.attachmentUrl ?? ""}`,
    ),
  }));
  let inserted = 0;
  for (const batch of chunk(rows, 500)) {
    const res = await ctx.db
      .insert(announcements)
      .values(batch)
      .onConflictDoNothing()
      .returning({ id: announcements.id });
    inserted += res.length;
  }
  return inserted;
}
