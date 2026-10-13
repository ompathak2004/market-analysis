import { throwIfAborted } from "@ma/core";
import {
  companies,
  companyAliases,
  eq,
  fencedTransaction,
  indexConstituents,
  indices,
  sql,
} from "@ma/db";
import type { IngestContext } from "../context.js";
import { normalizeCompanyName } from "../extract/relationships.js";
import { toYahooSymbol } from "../sources/yahoo.js";

const INDEX_NAMES: Record<string, { name: string; yahooSymbol: string | null }> = {
  NIFTY50: { name: "NIFTY 50", yahooSymbol: "^NSEI" },
  NIFTYNEXT50: { name: "NIFTY Next 50", yahooSymbol: "^NSMIDCP" },
  NIFTY100: { name: "NIFTY 100", yahooSymbol: "^CNX100" },
  NIFTY200: { name: "NIFTY 200", yahooSymbol: "^CNX200" },
  NIFTY500: { name: "NIFTY 500", yahooSymbol: "^CRSLDX" },
};

export async function syncUniverse(
  ctx: IngestContext,
  indexCode: string,
  signal?: AbortSignal,
): Promise<{ companies: number }> {
  const meta = INDEX_NAMES[indexCode];
  if (!meta) throw new Error(`Unknown index ${indexCode}`);
  const members = await ctx.nse.indexMembers(indexCode);
  throwIfAborted(signal);

  return fencedTransaction(
    ctx.db,
    async (tx) => {
      const [index] = await tx
        .insert(indices)
        .values({ code: indexCode, name: meta.name, yahooSymbol: meta.yahooSymbol })
        .onConflictDoUpdate({
          target: indices.code,
          set: { name: meta.name, yahooSymbol: meta.yahooSymbol },
        })
        .returning();
      if (!index) throw new Error("index upsert failed");

      const rows = members.map((m) => ({
        nseSymbol: m.symbol,
        isin: m.isin || null,
        name: m.name,
        normalizedName: normalizeCompanyName(m.name),
        industry: m.industry || null,
        yahooSymbol: toYahooSymbol(m.symbol),
        screenerSlug: m.symbol,
        updatedAt: new Date(),
      }));

      const upserted = await tx
        .insert(companies)
        .values(rows)
        .onConflictDoUpdate({
          target: companies.nseSymbol,
          set: {
            isin: sql`excluded.isin`,
            name: sql`excluded.name`,
            normalizedName: sql`excluded.normalized_name`,
            industry: sql`excluded.industry`,
            yahooSymbol: sql`excluded.yahoo_symbol`,
            updatedAt: sql`excluded.updated_at`,
          },
        })
        .returning({ id: companies.id, name: companies.name, nseSymbol: companies.nseSymbol });

      await tx.delete(indexConstituents).where(eq(indexConstituents.indexId, index.id));
      await tx
        .insert(indexConstituents)
        .values(upserted.map((c) => ({ indexId: index.id, companyId: c.id })));

      const aliasRows = upserted.flatMap((c) =>
        aliasesFor(c.name, c.nseSymbol).map((alias) => ({ companyId: c.id, alias })),
      );
      if (aliasRows.length) await tx.insert(companyAliases).values(aliasRows).onConflictDoNothing();

      ctx.logger.info({ indexCode, companies: upserted.length }, "universe synced");
      return { companies: upserted.length };
    },
    signal,
  );
}

export const GROUP_ALIASES: Record<string, string[]> = {
  RELIANCE: [
    "reliance jio",
    "jio platforms",
    "jio infocomm",
    "reliance retail",
    "reliance industries limited",
  ],
  BHARTIARTL: ["airtel", "bharti airtel"],
  TATAMOTORS: ["tata motors", "jaguar land rover"],
  MARUTI: ["maruti suzuki", "maruti"],
  ADANIENT: ["adani enterprises"],
  HINDALCO: ["novelis"],
  TATASTEEL: ["tata steel"],
  LT: ["larsen & toubro", "larsen and toubro", "l&t"],
};

export function aliasesFor(name: string, nseSymbol: string | null): string[] {
  const base = normalizeCompanyName(name);
  const out = new Set<string>([base, ...(nseSymbol ? (GROUP_ALIASES[nseSymbol] ?? []) : [])]);
  const noIndia = base.replace(/\s+\(?india\)?$/, "");
  if (noIndia !== base && noIndia.split(" ").length >= 2) out.add(noIndia);
  if (nseSymbol && nseSymbol.length >= 4 && !/^\d/.test(nseSymbol))
    out.add(nseSymbol.toLowerCase());
  return [...out];
}
