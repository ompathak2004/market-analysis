import { Suspense } from "react";
import { AltDataPane, BrokerCallsPane } from "@/components/panes/home/flow";
import { IntelligenceFeedPane, MarketBriefPane } from "@/components/panes/home/intel";
import { IndicesPane, MoversPane } from "@/components/panes/home/market";
import { PaneSkeleton } from "@/components/ui/pane";

export const dynamic = "force-dynamic";

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const alt = sp.alt === "air" || sp.alt === "sea" ? sp.alt : undefined;
  return (
    <div className="grid grid-home">
      <Suspense fallback={<PaneSkeleton id="indices" title="WORLD INDICES" area="indices" />}>
        <IndicesPane />
      </Suspense>
      <Suspense fallback={<PaneSkeleton id="brief" title="MARKET BRIEF" area="brief" />}>
        <MarketBriefPane />
      </Suspense>
      <Suspense fallback={<PaneSkeleton id="calls" title="BROKER CALLS" area="calls" />}>
        <BrokerCallsPane />
      </Suspense>
      <Suspense fallback={<PaneSkeleton id="movers" title="NIFTY 50 MOVERS" area="movers" />}>
        <MoversPane />
      </Suspense>
      <Suspense fallback={<PaneSkeleton id="feed" title="INTELLIGENCE FEED" area="feed" />}>
        <IntelligenceFeedPane />
      </Suspense>
      <Suspense fallback={<PaneSkeleton id="alt" title="ALT-DATA ACTIVITY" area="alt" />}>
        <AltDataPane {...(alt ? { layer: alt } : {})} />
      </Suspense>
    </div>
  );
}
