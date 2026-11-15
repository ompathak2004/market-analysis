import { chunk, throwIfAborted, uniqueBy } from "@ma/core";
import { announcements, companies, eq, fencedTransaction, lt, sql } from "@ma/db";
import { announcementDedupeKey } from "../announcements/dedupe.js";
import { ANNOUNCEMENT_POLICY_VERSION, announcementPolicy } from "../announcements/policy.js";
import type { IngestContext } from "../context.js";

export type AnnouncementSyncStats = {
  fetched: number;
  inserted: number;
  reclassified: number;
  noise: number;
};

export async function syncAnnouncements(
  ctx: IngestContext,
  companyId: number,
  signal?: AbortSignal,
): Promise<AnnouncementSyncStats> {
  const stats: AnnouncementSyncStats = { fetched: 0, inserted: 0, reclassified: 0, noise: 0 };
  const company = await ctx.db.query.companies.findFirst({ where: eq(companies.id, companyId) });
  if (!company?.nseSymbol) return stats;
  const symbol = company.nseSymbol;
  const items = await ctx.nse.announcements(symbol);
  stats.fetched = items.length;
  const rows = uniqueBy(
    items.flatMap((a) => {
      const policy = announcementPolicy({
        subject: a.subject,
        category: a.subject,
        details: a.details || null,
        publishedAt: a.publishedAt,
      });
      if (policy.retentionClass === "noise") {
        stats.noise++;
        return [];
      }
      return [
        {
          companyId,
          publishedAt: a.publishedAt,
          subject: a.subject,
          category: a.subject,
          details: a.details || null,
          attachmentUrl: a.attachmentUrl,
          dedupeKey: announcementDedupeKey({
            symbol,
            publishedAt: a.publishedAt,
            subject: a.subject,
            attachmentUrl: a.attachmentUrl,
          }),
          ...policy,
        },
      ];
    }),
    (r) => r.dedupeKey,
  );
  for (const batch of chunk(rows, 500)) {
    throwIfAborted(signal);
    const res = await fencedTransaction(
      ctx.db,
      (tx) =>
        tx
          .insert(announcements)
          .values(batch)
          .onConflictDoUpdate({
            target: announcements.dedupeKey,
            set: {
              categoryKey: sql`excluded.category_key`,
              retentionClass: sql`excluded.retention_class`,
              retainUntil: sql`excluded.retain_until`,
              policyVersion: sql`excluded.policy_version`,
            },
            setWhere: lt(announcements.policyVersion, ANNOUNCEMENT_POLICY_VERSION),
          })
          .returning({ inserted: sql<boolean>`xmax = 0` }),
      signal,
    );
    for (const r of res) {
      if (r.inserted) stats.inserted++;
      else stats.reclassified++;
    }
  }
  return stats;
}
