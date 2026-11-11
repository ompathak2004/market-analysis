import { NotFoundError } from "@ma/core";
import { z } from "zod";
import { BotStore } from "@/server/bot/store";
import { getContext } from "@/server/context";
import { requireAdmin } from "@/server/http/auth";
import { handle } from "@/server/http/respond";

export const dynamic = "force-dynamic";

export const GET = handle(async (req, params) => {
  const ctx = getContext();
  requireAdmin(ctx, req);
  const store = new BotStore(ctx.redis);
  if (params.id === "recent") return { traces: await store.recentTraces(100) };
  const trace = await store.trace(z.string().uuid().parse(params.id));
  if (!trace) throw new NotFoundError("trace", params.id ?? "");
  return trace;
});
