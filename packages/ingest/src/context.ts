import { Cache, RateLimiter, type RedisClient } from "@ma/cache";
import type { Config, Logger } from "@ma/core";
import type { Db } from "@ma/db";
import { DocumentStore } from "./documents.js";
import { Firecrawl } from "./firecrawl.js";
import { HttpClient } from "./http.js";
import { NseSource } from "./sources/nse.js";
import { YahooSource } from "./sources/yahoo.js";

export interface IngestContext {
  db: Db;
  redis: RedisClient;
  cache: Cache;
  http: HttpClient;
  firecrawl: Firecrawl;
  docs: DocumentStore;
  nse: NseSource;
  yahoo: YahooSource;
  logger: Logger;
  config: Config;
}

export const HOST_LIMITS = {
  "www.screener.in": { capacity: 5, perMs: 10_000 },
  "www.nseindia.com": { capacity: 3, perMs: 10_000 },
  "nsearchives.nseindia.com": { capacity: 5, perMs: 10_000 },
  "www.bseindia.com": { capacity: 3, perMs: 10_000 },
  "query1.finance.yahoo.com": { capacity: 10, perMs: 10_000 },
  "www.moneycontrol.com": { capacity: 5, perMs: 10_000 },
  "api.moneycontrol.com": { capacity: 10, perMs: 10_000 },
  "images.moneycontrol.com": { capacity: 5, perMs: 10_000 },
  "api.adsb.lol": { capacity: 30, perMs: 60_000 },
  "api.adsbdb.com": { capacity: 30, perMs: 60_000 },
  "opensky-network.org": { capacity: 20, perMs: 60_000 },
  "auth.opensky-network.org": { capacity: 5, perMs: 60_000 },
  "github.com": { capacity: 10, perMs: 60_000 },
  "raw.githubusercontent.com": { capacity: 10, perMs: 60_000 },
  "davidmegginson.github.io": { capacity: 5, perMs: 60_000 },
} satisfies Record<string, { capacity: number; perMs: number }>;

export function createIngestContext(deps: {
  db: Db;
  redis: RedisClient;
  config: Config;
  logger: Logger;
}): IngestContext {
  const { db, redis, config, logger } = deps;
  const limiter = new RateLimiter(redis, HOST_LIMITS);
  const http = new HttpClient(limiter, logger.child({ component: "http" }));
  const firecrawl = new Firecrawl(
    config.FIRECRAWL_API_KEY,
    logger.child({ component: "firecrawl" }),
  );
  return {
    db,
    redis,
    cache: new Cache(redis, { namespace: "ingest", version: 1, logger }),
    http,
    firecrawl,
    docs: new DocumentStore(db, http, firecrawl, logger.child({ component: "documents" })),
    nse: new NseSource(http, config.NSE_BASE_URL),
    yahoo: new YahooSource(http),
    logger,
    config,
  };
}
