import { createRedis } from "@ma/cache";
import { createLogger, loadServiceConfig, mapLimit } from "@ma/core";
import { closeDb, companies, createDb, eq, indexConstituents, indices } from "@ma/db";
import { createIngestContext } from "./context.js";
import { syncFundamentals } from "./pipelines/fundamentals.js";
import { syncAnnouncements } from "./pipelines/market.js";
import { syncPrices } from "./pipelines/prices.js";
import { extractRelationshipsForCompany, loadAliasMatcher } from "./pipelines/relationships.js";
import { syncUniverse } from "./pipelines/universe.js";

const config = loadServiceConfig();
const logger = createLogger("ingest-cli", config.LOG_LEVEL);
const db = createDb(config.DATABASE_URL, 4);
const redis = createRedis(config.REDIS_URL);
const ctx = createIngestContext({ db, redis, config, logger });

const [cmd, arg] = process.argv.slice(2);

async function companyIdsFor(indexCode: string): Promise<number[]> {
  const rows = await db
    .select({ id: indexConstituents.companyId })
    .from(indexConstituents)
    .innerJoin(indices, eq(indices.id, indexConstituents.indexId))
    .where(eq(indices.code, indexCode));
  return rows.map((r) => r.id);
}

async function symbolId(symbol: string): Promise<number> {
  const c = await db.query.companies.findFirst({ where: eq(companies.nseSymbol, symbol) });
  if (!c) throw new Error(`unknown symbol ${symbol}`);
  return c.id;
}

try {
  switch (cmd) {
    case "universe":
      console.log(await syncUniverse(ctx, arg ?? "NIFTY50"));
      break;
    case "prices": {
      const ids = arg?.startsWith("NIFTY")
        ? await companyIdsFor(arg)
        : [await symbolId(arg ?? "RELIANCE")];
      for (const id of ids) console.log(id, await syncPrices(ctx, id, "2y"));
      break;
    }
    case "fundamentals": {
      const ids = arg?.startsWith("NIFTY")
        ? await companyIdsFor(arg)
        : [await symbolId(arg ?? "RELIANCE")];
      for (const id of ids) console.log(id, await syncFundamentals(ctx, id));
      break;
    }
    case "announcements":
      console.log(await syncAnnouncements(ctx, await symbolId(arg ?? "RELIANCE")));
      break;
    case "relationships": {
      const ids = arg?.startsWith("NIFTY")
        ? await companyIdsFor(arg)
        : [await symbolId(arg ?? "SONACOMS")];
      const matcher = await loadAliasMatcher(ctx);
      const results = await mapLimit(ids, 2, async (id) => {
        const f = await syncFundamentals(ctx, id);
        if (!f) return null;
        const sources = [
          ...f.annualReports.slice(0, 2).map((a) => ({ ...a, kind: "annual_report" as const })),
          ...f.concalls.slice(0, 4).map((c) => ({ ...c, kind: "concall" as const })),
        ];
        const r = await extractRelationshipsForCompany(ctx, id, sources, matcher).catch(
          (err: unknown) => {
            logger.warn({ companyId: id, err }, "relationship extraction failed");
            return null;
          },
        );
        console.log(id, r);
        return r;
      });
      console.log({
        companies: ids.length,
        relationships: results.reduce((n, r) => n + (r?.relationships ?? 0), 0),
      });
      break;
    }
    default:
      console.log("usage: cli <universe|prices|fundamentals|announcements|relationships> [arg]");
  }
} finally {
  await closeDb(db);
  redis.disconnect();
}
