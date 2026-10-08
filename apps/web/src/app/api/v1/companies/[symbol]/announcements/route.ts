import { getContext } from "@/server/context";
import { requireApiKey } from "@/server/http/auth";
import { handle, query } from "@/server/http/respond";
import { limitQuery, symbolParams } from "@/server/http/schemas";
import { companyAnnouncements } from "@/server/queries";

export const dynamic = "force-dynamic";

export const GET = handle(async (req, p) => {
  const ctx = getContext();
  requireApiKey(ctx, req);
  return {
    items: await companyAnnouncements(
      ctx,
      symbolParams.parse(p).symbol,
      limitQuery(200, 40).parse(query(req)).limit,
    ),
  };
});
