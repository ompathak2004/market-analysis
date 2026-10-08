import { z } from "zod";
import { getContext } from "@/server/context";
import { requireApiKey } from "@/server/http/auth";
import { handle, query } from "@/server/http/respond";
import { signalLeaderboard } from "@/server/queries";

export const dynamic = "force-dynamic";

const params = z.object({ kind: z.string().regex(/^[a-z0-9_]+$/) });
const opts = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  order: z.enum(["asc", "desc"]).default("desc"),
});

export const GET = handle(async (req, p) => {
  const ctx = getContext();
  requireApiKey(ctx, req);
  const { kind } = params.parse(p);
  const { limit, order } = opts.parse(query(req));
  return { kind, rows: await signalLeaderboard(ctx, kind, limit, order) };
});
