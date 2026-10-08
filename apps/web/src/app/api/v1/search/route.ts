import { z } from "zod";
import { getContext } from "@/server/context";
import { requireApiKey } from "@/server/http/auth";
import { handle, query } from "@/server/http/respond";
import { searchCompanies } from "@/server/queries";

export const dynamic = "force-dynamic";

const schema = z.object({
  q: z.string().default(""),
  limit: z.coerce.number().int().min(1).max(50).default(12),
});

export const GET = handle(async (req) => {
  const ctx = getContext();
  requireApiKey(ctx, req, { allowSameOrigin: true });
  const { q, limit } = schema.parse(query(req));
  if (!q.trim()) return { results: [] };
  return { results: await searchCompanies(ctx, q, limit) };
});
