import { Suspense } from "react";
import {
  Empty,
  LatestCallsTable,
  Leaderboard,
  MoversTable,
  Panel,
  WorldIndices,
} from "@/components/panels";
import { getLatestCalls, getLeaderboard, getMarketOverview, getMovers } from "@/lib/api";
import { shortDate } from "@/lib/format";

export const dynamic = "force-dynamic";

export default function Home() {
  return (
    <div className="grid grid-home">
      <div style={{ gridArea: "indices" }}>
        <Suspense
          fallback={
            <Panel title="World indices">
              <Empty>Loading…</Empty>
            </Panel>
          }
        >
          <Indices />
        </Suspense>
      </div>
      <div style={{ gridArea: "movers" }} id="movers">
        <Suspense
          fallback={
            <Panel title="NIFTY 50 movers">
              <Empty>Loading…</Empty>
            </Panel>
          }
        >
          <Movers />
        </Suspense>
      </div>
      <div style={{ gridArea: "signals" }}>
        <Suspense
          fallback={
            <Panel title="Signals">
              <Empty>Loading…</Empty>
            </Panel>
          }
        >
          <Signals />
        </Suspense>
      </div>
      <div style={{ gridArea: "calls" }}>
        <Suspense
          fallback={
            <Panel title="Latest broker calls">
              <Empty>Loading…</Empty>
            </Panel>
          }
        >
          <Calls />
        </Suspense>
      </div>
    </div>
  );
}

async function Indices() {
  const data = await getMarketOverview().catch(() => null);
  return (
    <Panel
      title="World indices"
      sub={
        data
          ? `as of ${new Date(data.asOf).toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata" })} IST`
          : "unavailable"
      }
    >
      {data ? <WorldIndices indices={data.indices} /> : <Empty>API unavailable.</Empty>}
    </Panel>
  );
}

async function Movers() {
  const data = await getMovers().catch(() => null);
  return (
    <Panel title="NIFTY 50 movers" sub={data?.date ? shortDate(data.date) : ""}>
      <div className="grid grid-2" style={{ gap: 0 }}>
        <div className="panel-body tight">
          <div className="panel-head" style={{ color: "var(--up)" }}>
            Gainers
          </div>
          <MoversTable rows={data?.gainers ?? []} compact />
        </div>
        <div className="panel-body tight">
          <div className="panel-head" style={{ color: "var(--down)" }}>
            Losers
          </div>
          <MoversTable rows={data?.losers ?? []} compact />
        </div>
      </div>
    </Panel>
  );
}

async function Signals() {
  const [distress, momentum] = await Promise.all([
    getLeaderboard("distress_score", 8).catch(() => ({ rows: [] })),
    getLeaderboard("customer_momentum_3m", 8).catch(() => ({ rows: [] })),
  ]);
  return (
    <Panel title="Signals" sub={<a href="/signals">all →</a>}>
      <div className="grid grid-2" style={{ gap: 0 }}>
        <div className="panel-body tight">
          <div className="panel-head">Distress (DuPont)</div>
          <Leaderboard kind="distress_score" rows={distress.rows} compact />
        </div>
        <div className="panel-body tight">
          <div className="panel-head">Customer momentum 3M</div>
          <Leaderboard kind="customer_momentum_3m" rows={momentum.rows} compact />
        </div>
      </div>
    </Panel>
  );
}

async function Calls() {
  const data = await getLatestCalls(30).catch(() => ({ calls: [] }));
  return (
    <Panel title="Latest broker calls" sub="Trendlyne">
      <div className="panel-body tight">
        <LatestCallsTable calls={data.calls} />
      </div>
    </Panel>
  );
}
