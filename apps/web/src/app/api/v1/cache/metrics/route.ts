import { getContext } from "@/server/context";
import { requireApiKey } from "@/server/http/auth";
import { handle } from "@/server/http/respond";

export const dynamic = "force-dynamic";

export const GET = handle(async (req) => {
  const ctx = getContext();
  requireApiKey(ctx, req);
  return {
    api: await ctx.api.metrics(),
    ingest: await ctx.cache.metrics(),
    firecrawl: await ctx.firecrawlBudget.status(),
  };
});
