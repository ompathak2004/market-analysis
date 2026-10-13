import { getContext } from "@/server/context";
import { requireApiKey } from "@/server/http/auth";
import { handle, query } from "@/server/http/respond";
import { rangeQuery, symbolParams } from "@/server/http/schemas";
import { priceSnapshot } from "@/server/queries";

export const dynamic = "force-dynamic";

export const GET = handle(async (req, p) => {
  const ctx = getContext();
  requireApiKey(ctx, req);
  const { symbol } = symbolParams.parse(p);
  const { range } = rangeQuery.parse(query(req));
  return (await priceSnapshot(ctx, symbol, range)) ?? { bars: [], meta: null };
});
