import { chunk, sha256, throwIfAborted } from "@ma/core";
import { announcements, companies, eq, fencedTransaction } from "@ma/db";
import type { IngestContext } from "../context.js";

export async function syncAnnouncements(
  ctx: IngestContext,
  companyId: number,
  signal?: AbortSignal,
): Promise<number> {
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
    throwIfAborted(signal);
    const res = await fencedTransaction(
      ctx.db,
      (tx) =>
        tx
          .insert(announcements)
          .values(batch)
          .onConflictDoNothing()
          .returning({ id: announcements.id }),
      signal,
    );
    inserted += res.length;
  }
  return inserted;
}
