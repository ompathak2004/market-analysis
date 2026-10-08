import { getContext } from "@/server/context";
import { requireApiKey } from "@/server/http/auth";
import { handle, query } from "@/server/http/respond";
import { rangeQuery, symbolParams } from "@/server/http/schemas";
import { priceHistory } from "@/server/queries";

export const dynamic = "force-dynamic";

export const GET = handle(async (req, p) => {
  const ctx = getContext();
  requireApiKey(ctx, req);
  return {
    bars: await priceHistory(ctx, symbolParams.parse(p).symbol, rangeQuery.parse(query(req)).range),
  };
});
