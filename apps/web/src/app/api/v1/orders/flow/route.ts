import { z } from "zod";
import { getContext } from "@/server/context";
import { requireApiKey } from "@/server/http/auth";
import { handle, query } from "@/server/http/respond";
import { orderFlow } from "@/server/queries/orders";

export const dynamic = "force-dynamic";

const opts = z.object({
  months: z.coerce
    .number()
    .int()
    .refine((m) => m === 3 || m === 6 || m === 12 || m === 24)
    .default(12),
});

export const GET = handle(async (req) => {
  const ctx = getContext();
  requireApiKey(ctx, req);
  const { months } = opts.parse(query(req));
  return orderFlow(ctx, months as 3 | 6 | 12 | 24);
});
