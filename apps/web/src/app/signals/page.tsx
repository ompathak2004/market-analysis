import type { Metadata } from "next";
import { Suspense } from "react";
import { KindIndexPane, LeaderboardPane, OVERVIEW_KINDS } from "@/components/panes/screens/signals";
import { PaneSkeleton } from "@/components/ui/pane";
import { signalLabel } from "@/lib/format";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Signals · MA Terminal" };

export default async function SignalsPage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string; order?: string }>;
}) {
  const { kind, order } = await searchParams;
  if (kind && /^[a-z0-9_]{1,64}$/.test(kind))
    return (
      <div className="grid grid-signals-one">
        <Suspense
          key={`${kind}${order}`}
          fallback={<PaneSkeleton id="board" title={signalLabel(kind)} lines={20} />}
        >
          <LeaderboardPane kind={kind} limit={100} order={order === "asc" ? "asc" : "desc"} full />
        </Suspense>
        <KindIndexPane active={kind} />
      </div>
    );
  return (
    <div className="grid grid-signals">
      {OVERVIEW_KINDS.map((k) => (
        <Suspense key={k} fallback={<PaneSkeleton id={k} title={signalLabel(k)} />}>
          <LeaderboardPane kind={k} limit={25} order="desc" />
        </Suspense>
      ))}
    </div>
  );
}
