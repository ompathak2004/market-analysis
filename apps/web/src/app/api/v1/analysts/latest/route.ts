import { getContext } from "@/server/context";
import { requireApiKey } from "@/server/http/auth";
import { handle, query } from "@/server/http/respond";
import { limitQuery } from "@/server/http/schemas";
import { latestAnalystCalls } from "@/server/queries";

export const dynamic = "force-dynamic";

export const GET = handle(async (req) => {
  const ctx = getContext();
  requireApiKey(ctx, req);
  return { calls: await latestAnalystCalls(ctx, limitQuery(200, 50).parse(query(req)).limit) };
});
