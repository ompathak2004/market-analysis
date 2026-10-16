import { influenceDecision } from "@ma/db";
import { z } from "zod";
import { getContext } from "@/server/context";
import { requireAdmin } from "@/server/http/auth";
import { handle, jsonBody, query } from "@/server/http/respond";
import { reviewListQuery, reviewNote } from "@/server/http/schemas";
import { influenceReviewQueue, reviewInfluenceEdge } from "@/server/queries";

export const dynamic = "force-dynamic";

const decisionBody = z
  .object({
    edgeId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    decision: z.enum(influenceDecision.enumValues),
    expectedVersion: z.number().int().min(1).max(2_147_483_647),
    note: reviewNote,
  })
  .strict();

export const GET = handle(async (req) => {
  const ctx = getContext();
  requireAdmin(ctx, req);
  const { limit, cursor, kind } = reviewListQuery
    .extend({ kind: z.enum(["all", "political"]).default("all") })
    .parse(query(req));
  return influenceReviewQueue(ctx, {
    limit,
    cursor: cursor ?? null,
    political: kind === "political",
  });
});

export const POST = handle(async (req) => {
  const ctx = getContext();
  const reviewer = requireAdmin(ctx, req);
  const body = decisionBody.parse(await jsonBody(req));
  return reviewInfluenceEdge(
    ctx,
    {
      edgeId: body.edgeId,
      decision: body.decision,
      version: body.expectedVersion,
      note: body.note ?? null,
    },
    reviewer,
  );
});
