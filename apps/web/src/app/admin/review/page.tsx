import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { logout } from "@/app/admin/actions";
import { InfluenceReviewQueue } from "@/components/admin/influence-review-queue";
import { PrecisionGate } from "@/components/admin/precision-gate";
import { ReviewQueue } from "@/components/admin/review-queue";
import { attempt, PaneError } from "@/components/panes/shared";
import { type AppContext, getContext } from "@/server/context";
import { hasAdminSession } from "@/server/http/admin-session";
import {
  decodeCursor,
  decodeSampleCursor,
  influenceReviewQueue,
  precisionSummary,
  reviewQueue,
  sampleQueue,
} from "@/server/queries";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Review · MA Terminal",
  robots: { index: false, follow: false },
};

async function splcQueue(ctx: AppContext, sample: string | null, cursor: string | null) {
  if (!sample) return { page: await reviewQueue(ctx, { cursor }), summary: null };
  const [page, summary] = await Promise.all([
    sampleQueue(ctx, { name: sample, cursor }),
    precisionSummary(ctx, sample),
  ]);
  return { page, summary };
}

export default async function AdminReviewPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = getContext();
  if (!ctx.config.ADMIN_API_KEY) notFound();
  if (!(await hasAdminSession(ctx))) redirect("/admin/login");
  const params = await searchParams;
  const sample = typeof params.sample === "string" ? params.sample : null;
  const scope = sample ? `sample=${encodeURIComponent(sample)}` : null;
  const political = params.inflKind === "political";
  const raw = params.cursor;
  const cursor =
    typeof raw === "string" && (sample ? decodeSampleCursor(raw) : decodeCursor(raw)) ? raw : null;
  const rawInfl = params.infl;
  const inflCursor = typeof rawInfl === "string" && decodeCursor(rawInfl) ? rawInfl : null;
  const [res, infl] = await Promise.all([
    attempt(splcQueue(ctx, sample, cursor)),
    attempt(influenceReviewQueue(ctx, { cursor: inflCursor, political })),
  ]);
  return (
    <div className="grid grid-review admin-screen">
      {res.ok ? (
        <ReviewQueue
          items={res.data.page.items}
          nextCursor={res.data.page.nextCursor}
          paged={cursor != null}
          sample={sample}
          banner={res.data.summary ? <PrecisionGate summary={res.data.summary} /> : null}
          logout={
            <form action={logout}>
              <button type="submit" className="admin-button">
                LOG OUT
              </button>
            </form>
          }
        />
      ) : (
        <PaneError
          id="review"
          title={sample ? "REVIEW · SPLC PRECISION SAMPLE" : "REVIEW · SPLC OBSERVATIONS"}
          code={res.code}
          source={sample ? "relationship_precision_samples" : "relationship_observations"}
        />
      )}
      {infl.ok ? (
        <InfluenceReviewQueue
          items={infl.data.items}
          nextCursor={infl.data.nextCursor}
          paged={inflCursor != null}
          scope={scope}
          political={political}
        />
      ) : (
        <PaneError
          id="review-infl"
          title="REVIEW · INFLUENCE EDGES"
          code={infl.code}
          source="influence_edges"
        />
      )}
    </div>
  );
}
