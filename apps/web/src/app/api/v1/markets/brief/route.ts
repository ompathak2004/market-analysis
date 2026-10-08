import { getContext } from "@/server/context";
import { requireApiKey } from "@/server/http/auth";
import { handle } from "@/server/http/respond";
import { marketBrief } from "@/server/queries";

export const dynamic = "force-dynamic";

export const GET = handle(async (req) => {
  const ctx = getContext();
  requireApiKey(ctx, req);
  return marketBrief(ctx);
});
