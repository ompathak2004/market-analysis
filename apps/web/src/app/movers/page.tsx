import type { Metadata } from "next";
import { Suspense } from "react";
import { MoversBoardPane } from "@/components/panes/screens/movers";
import { PaneSkeleton } from "@/components/ui/pane";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Movers · MA Terminal" };

export default function MoversPage() {
  return (
    <div className="grid grid-movers">
      <Suspense fallback={<PaneSkeleton id="gainers" title="ADVANCERS" lines={20} />}>
        <MoversBoardPane side="gainers" />
      </Suspense>
      <Suspense fallback={<PaneSkeleton id="losers" title="DECLINERS" lines={20} />}>
        <MoversBoardPane side="losers" />
      </Suspense>
    </div>
  );
}
