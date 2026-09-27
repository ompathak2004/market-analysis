import cors from "@fastify/cors";
import { AppError } from "@ma/core";
import { eventImpact } from "@ma/intel";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "./context.js";
import * as q from "./queries.js";

const symbolParams = z.object({ symbol: z.string().min(1).max(20) });
const rangeQuery = z.object({
  range: z.enum(["5d", "1mo", "3mo", "6mo", "1y", "2y", "5y", "max"]).default("1y"),
});
const limitQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) });

export function buildApp(ctx: AppContext): FastifyInstance {
  const app: FastifyInstance = Fastify({
    loggerInstance: ctx.logger.child({ component: "http-server" }) as FastifyBaseLogger,
    trustProxy: true,
  });

  app.register(cors, {
    origin: ctx.config.CORS_ORIGINS.split(",").map((o) => o.trim()),
    allowedHeaders: ["content-type", "x-api-key"],
  });

  app.addHook("onRequest", async (req, reply) => {
    if (req.url === "/health" || req.method === "OPTIONS") return;
    if (req.headers["x-api-key"] !== ctx.config.API_KEY) {
      return reply
        .code(401)
        .send({ error: { code: "UNAUTHORIZED", message: "missing or invalid x-api-key" } });
    }
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof z.ZodError) {
      return reply.code(400).send({
        error: { code: "BAD_REQUEST", message: "invalid request", details: err.flatten() },
      });
    }
    if (err instanceof AppError) {
      return reply
        .code(err.status)
        .send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    req.log.error({ err }, "unhandled error");
    return reply.code(500).send({ error: { code: "INTERNAL", message: "internal error" } });
  });

  app.get("/health", async () => ({ ok: true, ts: new Date().toISOString() }));

  app.get("/v1/search", async (req) => {
    const { q: term, limit } = z
      .object({
        q: z.string().default(""),
        limit: z.coerce.number().int().min(1).max(50).default(12),
      })
      .parse(req.query);
    return { results: await q.searchCompanies(ctx, term, limit) };
  });

  app.get("/v1/markets/overview", () => q.marketOverview(ctx));
  app.get("/v1/markets/movers", async (req) =>
    q.movers(
      ctx,
      z.object({ limit: z.coerce.number().int().min(1).max(50).default(10) }).parse(req.query)
        .limit,
    ),
  );

  app.get("/v1/analysts/latest", async (req) => ({
    calls: await q.latestAnalystCalls(ctx, limitQuery.parse(req.query).limit),
  }));

  app.get("/v1/signals/:kind", async (req) => {
    const { kind } = z.object({ kind: z.string().regex(/^[a-z0-9_]+$/) }).parse(req.params);
    const { limit, order } = z
      .object({
        limit: z.coerce.number().int().min(1).max(200).default(50),
        order: z.enum(["asc", "desc"]).default("desc"),
      })
      .parse(req.query);
    return { kind, rows: await q.signalLeaderboard(ctx, kind, limit, order) };
  });

  app.get("/v1/companies/:symbol", async (req) =>
    q.companyOverview(ctx, symbolParams.parse(req.params).symbol),
  );
  app.get("/v1/companies/:symbol/prices", async (req) => ({
    bars: await q.priceHistory(
      ctx,
      symbolParams.parse(req.params).symbol,
      rangeQuery.parse(req.query).range,
    ),
  }));
  app.get("/v1/companies/:symbol/financials", async (req) =>
    q.financials(ctx, symbolParams.parse(req.params).symbol),
  );
  app.get("/v1/companies/:symbol/analysts", async (req) =>
    q.analystView(ctx, symbolParams.parse(req.params).symbol),
  );
  app.get("/v1/companies/:symbol/supply-chain", async (req) =>
    q.supplyChain(ctx, symbolParams.parse(req.params).symbol),
  );
  app.get("/v1/companies/:symbol/announcements", async (req) => ({
    items: await q.companyAnnouncements(
      ctx,
      symbolParams.parse(req.params).symbol,
      z.object({ limit: z.coerce.number().int().min(1).max(200).default(40) }).parse(req.query)
        .limit,
    ),
  }));

  app.get("/v1/events/impact", async (req) => {
    const { symbol, from, to, minExposurePct } = z
      .object({
        symbol: z.string(),
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        minExposurePct: z.coerce.number().min(0).max(100).default(0),
      })
      .parse(req.query);
    const company = await q.findCompany(ctx, symbol);
    return ctx.api.getOrLoad(
      `event:${company.id}:${from}:${to}:${minExposurePct}`,
      () => eventImpact(ctx.db, company.id, from, to, { minExposurePct }),
      { ttlMs: 30 * 60_000, staleMs: 6 * 3_600_000 },
    );
  });

  app.get("/v1/cache/metrics", async () => ({
    api: await ctx.api.metrics(),
    ingest: await ctx.cache.metrics(),
  }));

  return app;
}
