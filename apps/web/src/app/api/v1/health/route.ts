import { ingestRuns, sql } from "@ma/db";
import { getContext } from "@/server/context";
import { json } from "@/server/http/respond";

export const dynamic = "force-dynamic";

export async function GET() {
  const ctx = getContext();
  const [db, redis] = await Promise.all([
    ctx.db
      .execute(sql`select 1`)
      .then(() => "ok" as const)
      .catch(() => "down" as const),
    ctx.redis
      .ping()
      .then(() => "ok" as const)
      .catch(() => "down" as const),
  ]);
  const jobs =
    db === "ok"
      ? await ctx.db
          .select({
            job: ingestRuns.source,
            status: ingestRuns.status,
            finishedAt: sql<string | null>`max(${ingestRuns.finishedAt})`,
          })
          .from(ingestRuns)
          .groupBy(ingestRuns.source, ingestRuns.status)
      : [];
  const ok = db === "ok" && redis === "ok";
  return json({ ok, db, redis, jobs, ts: new Date().toISOString() }, ok ? 200 : 503);
}
