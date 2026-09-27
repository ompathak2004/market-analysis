import { isoDate, mapLimit } from "@ma/core";
import { companies, eq, indexConstituents, indices, sql } from "@ma/db";
import {
  extractRelationshipsForCompany,
  loadAliasMatcher,
  syncAnalystCalls,
  syncAnnouncements,
  syncFundamentals,
  syncPrices,
  syncUniverse,
} from "@ma/ingest";
import { refreshEstimates, refreshMomentumSignals, refreshRiskSignals } from "@ma/intel";
import type { AppContext } from "../context.js";
import type { Job } from "./scheduler.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const UNIVERSE = "NIFTY500";

async function universeIds(ctx: AppContext): Promise<number[]> {
  const rows = await ctx.db
    .select({ id: indexConstituents.companyId })
    .from(indexConstituents)
    .innerJoin(indices, eq(indices.id, indexConstituents.indexId))
    .where(eq(indices.code, UNIVERSE));
  return rows.map((r) => r.id);
}

async function staleFundamentalIds(ctx: AppContext, limit: number): Promise<number[]> {
  const rows = await ctx.db.execute<{ id: number }>(sql`
    select c.id from companies c
    join index_constituents ic on ic.company_id = c.id
    join indices i on i.id = ic.index_id and i.code = ${UNIVERSE}
    left join documents d on d.company_id = c.id and d.source = 'screener'
    order by d.fetched_at nulls first
    limit ${limit}`);
  return rows.map((r) => r.id);
}

function tally(results: Array<Record<string, number> | number | null>): Record<string, number> {
  const out: Record<string, number> = { items: results.length };
  for (const r of results) {
    if (r == null) continue;
    if (typeof r === "number") out.total = (out.total ?? 0) + r;
    else for (const [k, v] of Object.entries(r)) out[k] = (out[k] ?? 0) + v;
  }
  return out;
}

export function buildJobs(ctx: AppContext): Job[] {
  const concurrency = ctx.config.SCRAPE_CONCURRENCY;
  return [
    {
      name: "universe",
      everyMs: DAY,
      run: async () => {
        const results = await Promise.all(
          ["NIFTY50", "NIFTYNEXT50", "NIFTY100", "NIFTY200", UNIVERSE].map((i) =>
            syncUniverse(ctx, i),
          ),
        );
        await ctx.api.invalidatePrefix("search:");
        return tally(results);
      },
    },
    {
      name: "prices",
      everyMs: 4 * HOUR,
      activeHoursIst: [16, 24],
      run: async () => {
        const ids = await universeIds(ctx);
        const results = await mapLimit(ids, concurrency, (id) =>
          syncPrices(ctx, id, "1mo").catch(() => 0),
        );
        await ctx.api.invalidatePrefix("prices:");
        await ctx.api.invalidatePrefix("movers:");
        return tally(results);
      },
    },
    {
      name: "fundamentals",
      everyMs: HOUR,
      run: async () => {
        const ids = await staleFundamentalIds(ctx, 40);
        const results = await mapLimit(ids, 2, (id) =>
          syncFundamentals(ctx, id)
            .then((r) => (r ? { periods: r.periods, changed: r.changed ? 1 : 0 } : null))
            .catch(() => null),
        );
        await ctx.api.invalidatePrefix("financials:");
        await ctx.api.invalidatePrefix("company:");
        return tally(results);
      },
    },
    {
      name: "analysts",
      everyMs: 30 * MINUTE,
      run: async () => {
        const r = await syncAnalystCalls(ctx, 3);
        await ctx.api.invalidatePrefix("analysts:");
        return r;
      },
    },
    {
      name: "announcements",
      everyMs: 2 * HOUR,
      run: async () => {
        const ids = await universeIds(ctx);
        const results = await mapLimit(ids, 1, (id) => syncAnnouncements(ctx, id).catch(() => 0));
        await ctx.api.invalidatePrefix("announcements:");
        return tally(results);
      },
    },
    {
      name: "relationships",
      everyMs: 6 * HOUR,
      run: async () => {
        const ids = await staleRelationshipIds(ctx, 15);
        const matcher = await loadAliasMatcher(ctx);
        const results = await mapLimit(ids, 1, async (id) => {
          const f = await syncFundamentals(ctx, id);
          if (!f) return null;
          const sources = [
            ...f.annualReports.slice(0, 2).map((a) => ({ ...a, kind: "annual_report" as const })),
            ...f.concalls.slice(0, 4).map((c) => ({ ...c, kind: "concall" as const })),
          ];
          const r = await extractRelationshipsForCompany(ctx, id, sources, matcher);
          return { documents: r.documents, relationships: r.relationships };
        });
        await ctx.api.invalidatePrefix("supply-chain:");
        return tally(results);
      },
    },
    {
      name: "intel",
      everyMs: 12 * HOUR,
      run: async () => {
        const asOf = isoDate(new Date());
        const ids = (await ctx.db.select({ id: companies.id }).from(companies)).map((c) => c.id);
        const estimates = await refreshEstimates(ctx.db, asOf);
        const momentum = await refreshMomentumSignals(ctx.db, asOf);
        const risk = await refreshRiskSignals(ctx.db, ids, asOf);
        await ctx.api.invalidatePrefix("signals:");
        await ctx.api.invalidatePrefix("leaderboard:");
        await ctx.api.invalidatePrefix("supply-chain:");
        return { estimates, momentum, risk };
      },
    },
  ];
}

async function staleRelationshipIds(ctx: AppContext, limit: number): Promise<number[]> {
  const rows = await ctx.db.execute<{ id: number }>(sql`
    select c.id from companies c
    join index_constituents ic on ic.company_id = c.id
    join indices i on i.id = ic.index_id and i.code = ${UNIVERSE}
    left join (
      select company_id, max(fetched_at) last from documents where source in ('annual_report', 'concall') group by company_id
    ) d on d.company_id = c.id
    where c.industry !~* 'bank|financ|insurance'
    order by d.last nulls first, c.market_cap_cr desc nulls last
    limit ${limit}`);
  return rows.map((r) => r.id);
}
