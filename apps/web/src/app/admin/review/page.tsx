import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { logout } from "@/app/admin/actions";
import { ReviewQueue } from "@/components/admin/review-queue";
import { attempt, PaneError } from "@/components/panes/shared";
import { getContext } from "@/server/context";
import { hasAdminSession } from "@/server/http/admin-session";
import { decodeCursor, reviewQueue } from "@/server/queries";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Review · MA Terminal",
  robots: { index: false, follow: false },
};

export default async function AdminReviewPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = getContext();
  if (!ctx.config.ADMIN_API_KEY) notFound();
  if (!(await hasAdminSession(ctx))) redirect("/admin/login");
  const raw = (await searchParams).cursor;
  const cursor = typeof raw === "string" && decodeCursor(raw) ? raw : null;
  const res = await attempt(reviewQueue(ctx, { cursor }));
  return (
    <div className="grid grid-solo admin-screen">
      {res.ok ? (
        <ReviewQueue
          items={res.data.items}
          nextCursor={res.data.nextCursor}
          paged={cursor != null}
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
          title="REVIEW · SPLC OBSERVATIONS"
          code={res.code}
          source="relationship_observations"
        />
      )}
    </div>
  );
}
