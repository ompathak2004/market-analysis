import { reviewDecision } from "@ma/db";
import { z } from "zod";
import { getContext } from "@/server/context";
import { requireAdmin } from "@/server/http/auth";
import { handle, jsonBody, query } from "@/server/http/respond";
import { reviewListQuery, reviewNote } from "@/server/http/schemas";
import { reviewQueue, reviewRelationship } from "@/server/queries";

export const dynamic = "force-dynamic";

const decisionBody = z
  .object({
    observationId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    decision: z.enum(reviewDecision.enumValues),
    note: reviewNote,
  })
  .strict();

export const GET = handle(async (req) => {
  const ctx = getContext();
  requireAdmin(ctx, req);
  const { limit, cursor } = reviewListQuery.parse(query(req));
  return reviewQueue(ctx, { limit, cursor: cursor ?? null });
});

export const POST = handle(async (req) => {
  const ctx = getContext();
  const reviewer = requireAdmin(ctx, req);
  const body = decisionBody.parse(await jsonBody(req));
  return reviewRelationship(
    ctx,
    { observationId: body.observationId, decision: body.decision, note: body.note ?? null },
    reviewer,
  );
});
