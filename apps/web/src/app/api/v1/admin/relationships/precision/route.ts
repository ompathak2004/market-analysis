import { getContext } from "@/server/context";
import { requireAdmin } from "@/server/http/auth";
import { handle, query } from "@/server/http/respond";
import { precisionQuery } from "@/server/http/schemas";
import { precisionSummary } from "@/server/queries";

export const dynamic = "force-dynamic";

export const GET = handle(async (req) => {
  const ctx = getContext();
  requireAdmin(ctx, req);
  const { sample } = precisionQuery.parse(query(req));
  return precisionSummary(ctx, sample);
});
