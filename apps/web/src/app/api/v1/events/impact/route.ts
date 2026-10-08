import { eventImpact } from "@ma/intel";
import { z } from "zod";
import { getContext } from "@/server/context";
import { requireApiKey } from "@/server/http/auth";
import { handle, query } from "@/server/http/respond";
import { isoDateString } from "@/server/http/schemas";
import { findCompany } from "@/server/queries";

export const dynamic = "force-dynamic";

const schema = z.object({
  symbol: z.string(),
  from: isoDateString,
  to: isoDateString,
  minExposurePct: z.coerce.number().min(0).max(100).default(0),
});

export const GET = handle(async (req) => {
  const ctx = getContext();
  requireApiKey(ctx, req);
  const { symbol, from, to, minExposurePct } = schema.parse(query(req));
  const company = await findCompany(ctx, symbol);
  return ctx.api.getOrLoad(
    `event:${company.id}:${from}:${to}:${minExposurePct}`,
    () => eventImpact(ctx.db, company.id, from, to, { minExposurePct }),
    { ttlMs: 30 * 60_000, staleMs: 6 * 3_600_000 },
  );
});
