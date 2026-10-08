import { getContext } from "@/server/context";
import { requireApiKey } from "@/server/http/auth";
import { handle } from "@/server/http/respond";
import { symbolParams } from "@/server/http/schemas";
import { companyOverview } from "@/server/queries";

export const dynamic = "force-dynamic";

export const GET = handle(async (req, p) => {
  const ctx = getContext();
  requireApiKey(ctx, req);
  return companyOverview(ctx, symbolParams.parse(p).symbol);
});
