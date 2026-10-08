import { getContext } from "@/server/context";
import { requireApiKey } from "@/server/http/auth";
import { handle, query } from "@/server/http/respond";
import { limitQuery } from "@/server/http/schemas";
import { movers } from "@/server/queries";

export const dynamic = "force-dynamic";

export const GET = handle(async (req) => {
  const ctx = getContext();
  requireApiKey(ctx, req);
  return movers(ctx, limitQuery(50, 10).parse(query(req)).limit);
});
