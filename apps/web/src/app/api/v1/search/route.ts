import { z } from "zod";
import { getContext } from "@/server/context";
import { limitPublic } from "@/server/http/auth";
import { handle, query } from "@/server/http/respond";
import { searchCompanies } from "@/server/queries";

export const dynamic = "force-dynamic";

const schema = z.object({
  q: z.string().default(""),
  limit: z.coerce.number().int().min(1).max(50).default(12),
});

/**
 * Public on purpose: the browser command bar calls it without an API key. It only exposes
 * listed-company identifiers already shown on every page and is rate-limited per client IP.
 */
export const GET = handle(async (req) => {
  const ctx = getContext();
  await limitPublic(ctx, req, "search");
  const { q, limit } = schema.parse(query(req));
  if (!q.trim()) return { results: [] };
  const hits = await searchCompanies(ctx, q, limit);
  return {
    results: (hits ?? []).map(({ nseSymbol, name, sector }) => ({ nseSymbol, name, sector })),
  };
});
