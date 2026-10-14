import { AppError } from "@ma/core";
import { influenceDecision } from "@ma/db";
import { z } from "zod";
import { getContext } from "@/server/context";
import { requireAdmin } from "@/server/http/auth";
import { handle, query } from "@/server/http/respond";
import {
  decodeCursor,
  influenceReviewQueue,
  REVIEW_PAGE_DEFAULT,
  REVIEW_PAGE_MAX,
  reviewInfluenceEdge,
} from "@/server/queries";

export const dynamic = "force-dynamic";

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(REVIEW_PAGE_MAX).default(REVIEW_PAGE_DEFAULT),
  cursor: z
    .string()
    .refine((c) => decodeCursor(c) != null, "invalid cursor")
    .optional(),
});

const decisionBody = z
  .object({
    edgeId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    decision: z.enum(influenceDecision.enumValues),
    expectedVersion: z.number().int().min(1).max(2_147_483_647),
    note: z.string().trim().max(500).nullish(),
  })
  .strict();

export const GET = handle(async (req) => {
  const ctx = getContext();
  requireAdmin(ctx, req);
  const { limit, cursor } = listQuery.parse(query(req));
  return influenceReviewQueue(ctx, { limit, cursor: cursor ?? null });
});

export const POST = handle(async (req) => {
  const ctx = getContext();
  const reviewer = requireAdmin(ctx, req);
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    throw new AppError("content-type must be application/json", "UNSUPPORTED_MEDIA_TYPE", 415);
  }
  const raw: unknown = await req.json().catch(() => {
    throw new AppError("invalid json body", "BAD_REQUEST", 400);
  });
  const body = decisionBody.parse(raw);
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
