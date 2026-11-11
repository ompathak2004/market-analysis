import { AppError } from "@ma/core";
import { z } from "zod";
import { PORTFOLIO_IDS } from "@/server/bot/portfolio";
import { ChatConflict, prepareChat, runChat } from "@/server/bot/run";
import { getContext } from "@/server/context";
import { clientIp, limitPublic, rateSubject } from "@/server/http/auth";
import { errorResponse, jsonBody } from "@/server/http/respond";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const schema = z.object({
  conversationId: z.string().uuid().nullable(),
  requestId: z.string().uuid(),
  portfolioId: z.enum(PORTFOLIO_IDS).nullable(),
  message: z.string().trim().min(1).max(2_000),
});

export async function POST(req: Request): Promise<Response> {
  const ctx = getContext();
  let input: z.infer<typeof schema>;
  let prepared: Awaited<ReturnType<typeof prepareChat>>;
  const ip = clientIp(req);
  try {
    if (!ctx.config.BOT_ENABLED) throw new AppError("assistant is disabled", "BOT_DISABLED", 503);
    input = schema.parse(await jsonBody(req));
    await limitPublic(ctx, req, "bot", rateSubject(ip));
    await limitPublic(ctx, req, "botDaily", rateSubject(ip));
    prepared = await prepareChat(ctx, { ...input, ip });
  } catch (err) {
    if (err instanceof ChatConflict)
      return errorResponse(new AppError(err.message, "CONFLICT", 409));
    return errorResponse(err);
  }
  const encoder = new TextEncoder();
  const abort = new AbortController();
  if (req.signal.aborted) abort.abort();
  req.signal.addEventListener("abort", () => abort.abort(), { once: true });
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const emit = (e: unknown) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(e)}\n`));
        } catch {
          open = false;
        }
      };
      await runChat(ctx, { ...input, ip }, prepared, abort.signal, emit);
      open = false;
      try {
        controller.close();
      } catch {}
    },
    cancel() {
      abort.abort();
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
      "x-conversation-id": prepared.conversation.id,
    },
  });
}
