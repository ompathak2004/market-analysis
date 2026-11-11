import { NotFoundError } from "@ma/core";
import { z } from "zod";
import { BotStore } from "@/server/bot/store";
import { getContext } from "@/server/context";
import { limitPublic } from "@/server/http/auth";
import { handle } from "@/server/http/respond";

export const dynamic = "force-dynamic";

const id = z.string().uuid();

export const GET = handle(async (req, params) => {
  const ctx = getContext();
  await limitPublic(ctx, req, "botRead");
  const conv = await new BotStore(ctx.redis).load(id.parse(params.id));
  if (!conv) throw new NotFoundError("conversation", "expired or unknown");
  return {
    id: conv.id,
    portfolioId: conv.portfolioId,
    updatedAt: conv.updatedAt,
    turns: conv.turns.map((t) => ({
      id: t.id,
      at: t.at,
      portfolioId: t.portfolioId,
      user: t.user,
      assistant: t.assistant,
      status: t.status,
      tools: t.tools.map((x) => ({ callId: x.callId, name: x.name, ok: x.ok, summary: x.summary })),
      citations: t.citations,
      charts: t.charts,
    })),
  };
});

export const DELETE = handle(async (req, params) => {
  const ctx = getContext();
  await limitPublic(ctx, req, "botRead");
  await new BotStore(ctx.redis).remove(id.parse(params.id));
  return { ok: true };
});
