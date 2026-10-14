import { getContext } from "@/server/context";
import { requireAdmin } from "@/server/http/auth";
import { handle } from "@/server/http/respond";
import { jobsSummary } from "@/server/queries";

export const dynamic = "force-dynamic";

export const GET = handle(async (req) => {
  const ctx = getContext();
  requireAdmin(ctx, req);
  return jobsSummary(ctx);
});
