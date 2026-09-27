import { Suspense } from "react";
import {
  Empty,
  LatestCallsTable,
  Leaderboard,
  MoversTable,
  Panel,
  Unavailable,
  WorldIndices,
} from "@/components/panels";
import { attempt, getLatestCalls, getLeaderboard, getMarketOverview, getMovers } from "@/lib/api";
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
  const res = await attempt(getMarketOverview());
  return (
    <Panel
      title="World indices"
      sub={
        res.ok
          ? `as of ${new Date(res.data.asOf).toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata" })} IST`
          : "unavailable"
      }
    >
      {res.ok ? <WorldIndices indices={res.data.indices} /> : <Unavailable error={res.error} />}
    </Panel>
  );
}

async function Movers() {
  const res = await attempt(getMovers());
  if (!res.ok)
    return (
      <Panel title="NIFTY 50 movers">
        <Unavailable error={res.error} />
      </Panel>
    );
  const data = res.data;
  return (
    <Panel title="NIFTY 50 movers" sub={data.date ? shortDate(data.date) : ""}>
      <div className="grid grid-2" style={{ gap: 0 }}>
        <div className="panel-body tight">
          <div className="panel-head" style={{ color: "var(--up)" }}>
            Gainers
          </div>
          <MoversTable rows={data.gainers} compact />
        </div>
        <div className="panel-body tight">
          <div className="panel-head" style={{ color: "var(--down)" }}>
            Losers
          </div>
          <MoversTable rows={data.losers} compact />
        </div>
      </div>
    </Panel>
  );
}

async function Signals() {
  const [distress, momentum] = await Promise.all([
    attempt(getLeaderboard("distress_score", 8)),
    attempt(getLeaderboard("customer_momentum_3m", 8)),
  ]);
  return (
    <Panel title="Signals" sub={<a href="/signals">all →</a>}>
      <div className="grid grid-2" style={{ gap: 0 }}>
        <div className="panel-body tight">
          <div className="panel-head">Distress (DuPont)</div>
          {distress.ok ? (
            <Leaderboard kind="distress_score" rows={distress.data.rows} compact />
          ) : (
            <Unavailable error={distress.error} />
          )}
        </div>
        <div className="panel-body tight">
          <div className="panel-head">Customer momentum 3M</div>
          {momentum.ok ? (
            <Leaderboard kind="customer_momentum_3m" rows={momentum.data.rows} compact />
          ) : (
            <Unavailable error={momentum.error} />
          )}
        </div>
      </div>
    </Panel>
  );
}

async function Calls() {
  const res = await attempt(getLatestCalls(30));
  return (
    <Panel title="Latest broker calls" sub="Trendlyne">
      <div className="panel-body tight">
        {res.ok ? <LatestCallsTable calls={res.data.calls} /> : <Unavailable error={res.error} />}
      </div>
    </Panel>
  );
}
