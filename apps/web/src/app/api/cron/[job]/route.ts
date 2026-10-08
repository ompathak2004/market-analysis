import { getContext } from "@/server/context";
import { requireCronSecret } from "@/server/http/auth";
import { errorResponse, json } from "@/server/http/respond";
import { getJob, jobNames, runJob } from "@/server/jobs";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function trigger(req: Request, params: Promise<{ job: string }>): Promise<Response> {
  try {
    const ctx = getContext();
    requireCronSecret(ctx, req);
    const { job } = await params;
    const def = getJob(job);
    if (!def)
      return json(
        { error: { code: "NOT_FOUND", message: `unknown job ${job}`, jobs: jobNames() } },
        404,
      );
    const outcome = await runJob(ctx, def.name, def.budgetMs, def.run);
    return json({ job: def.name, ...outcome });
  } catch (err) {
    return errorResponse(err);
  }
}

export function GET(req: Request, ctx: { params: Promise<{ job: string }> }) {
  return trigger(req, ctx.params);
}

export function POST(req: Request, ctx: { params: Promise<{ job: string }> }) {
  return trigger(req, ctx.params);
}
