import { Suspense } from "react";
import { Badge } from "@/components/ui/chip";
import { DataTable } from "@/components/ui/data-table";
import { Empty } from "@/components/ui/empty";
import { Pane, PaneSkeleton } from "@/components/ui/pane";
import { Bars } from "@/components/ui/sparkline";
import { istTime, minutes, shortDate } from "@/lib/format";
import { getContext } from "@/server/context";
import { type AirportRef, type CompanyTravel, companyTravel } from "@/server/queries";
import { attempt, PaneError } from "../shared";
import { AltSignalsPane, NoCoverage, sourceLabels } from "./alt";

type Aircraft = CompanyTravel["aircraft"][number];
type Leg = CompanyTravel["legs"][number];

const TIER_TONE: Record<string, "pos" | "warn" | "neu"> = {
  registry: "pos",
  verified: "pos",
  press: "warn",
  inferred: "warn",
};

function placeCode(p: AirportRef | null): string {
  return p ? (p.iata ?? p.icao) : "???";
}

function placeLabel(p: AirportRef | null): string {
  if (!p) return "unknown";
  return `${placeCode(p)} ${p.city ?? ""}`.trim();
}

function legTime(at: string | null): string {
  if (!at) return "—";
  return `${shortDate(at)} ${istTime(at)}`;
}

function AircraftPane({ symbol, t }: { symbol: string; t: CompanyTravel }) {
  return (
    <Pane
      id="aircraft"
      title="AIRCRAFT REGISTRY"
      area="aircraft"
      meta={`${t.aircraft.length} linked aircraft`}
      foot={
        <>
          <output>DGCA · press · manual review</output>
          <span className="right">
            {t.registryVerifiedAt ? `verified ${shortDate(t.registryVerifiedAt)}` : "unverified"}
          </span>
        </>
      }
    >
      <DataTable<Aircraft>
        label={`${symbol} linked aircraft`}
        rows={t.aircraft}
        rowKey={(a) => a.registration}
        columns={[
          {
            key: "r",
            header: "REG",
            width: "sm",
            cell: (a) => <b className="accent">{a.registration}</b>,
          },
          { key: "t", header: "TYPE", width: "md", cell: (a) => a.model ?? a.icaoType ?? "—" },
          {
            key: "p",
            header: "LINKED PERSON / ROLE",
            cell: (a) =>
              a.privacyFlagged ? (
                <span className="muted">withheld · privacy</span>
              ) : (
                <span className="truncate">
                  {[a.linkedPerson ?? a.groupName, a.linkedRole].filter(Boolean).join(" · ") || "—"}
                </span>
              ),
          },
          {
            key: "c",
            header: "CONFIDENCE",
            width: "md",
            sortable: true,
            sortValue: (a) => a.confidence,
            cell: (a) => (
              <Badge tone={TIER_TONE[a.tier] ?? "neu"}>
                {a.confidence >= 0.75 ? "HIGH" : a.confidence >= 0.45 ? "MED" : "LOW"} · {a.tier}
              </Badge>
            ),
          },
          {
            key: "s",
            header: "LAST SEEN",
            width: "date",
            priority: 2,
            cell: (a) => shortDate(a.lastSeenAt),
          },
        ]}
      />
      <p className="pane-section dim sm">
        Corporate association ≠ passenger identity. No occupant is verified.
      </p>
    </Pane>
  );
}

function LegsPane({ t }: { t: CompanyTravel }) {
  const c = t.coverage;
  return (
    <Pane
      id="legs"
      title="RECENT LEGS"
      area="legs"
      meta={`30D · ${c.legs30d} legs`}
      foot={
        <>
          <output>{sourceLabels(t.sources) || "ADS-B"}</output>
          <span className="right">
            {t.legs.length} of {c.legs30d} legs · {c.legsFull30d} complete
          </span>
        </>
      }
    >
      <DataTable<Leg>
        label="Recent flight legs"
        rows={t.legs}
        rowKey={(l) => l.id}
        columns={[
          {
            key: "d",
            header: "DATE · IST",
            width: "md",
            sortable: true,
            sortValue: (l) => (l.departedAt ? new Date(l.departedAt).getTime() : null),
            cell: (l) => legTime(l.departedAt ?? l.arrivedAt),
          },
          { key: "r", header: "REG", width: "sm", cell: (l) => l.registration },
          {
            key: "ft",
            header: "FROM → TO · CITY",
            cell: (l) => (
              <span className="truncate">
                {placeLabel(l.dep)} → {placeLabel(l.arr)}
              </span>
            ),
          },
          {
            key: "du",
            header: "DURATION",
            width: "sm",
            align: "right",
            sortable: true,
            sortValue: (l) => l.durationMin,
            cell: (l) => minutes(l.durationMin),
          },
          {
            key: "s",
            header: "SOURCE",
            width: "sm",
            priority: 2,
            cell: (l) => <span className={l.completeness === "full" ? "" : "dim"}>{l.source}</span>,
            title: (l) => `completeness ${l.completeness}`,
          },
        ]}
        empty={
          <Empty title="No legs in 30 days">
            Linked aircraft have not been seen on a complete leg recently.
          </Empty>
        }
      />
      {t.weeklyLegCounts.length ? (
        <div className="pane-section">
          <h3>Legs per week</h3>
          <Bars
            data={t.weeklyLegCounts.map((w) => ({ label: w.weekStart.slice(5), value: w.count }))}
            label="Weekly leg counts"
            height={40}
          />
        </div>
      ) : null}
    </Pane>
  );
}

interface Route {
  code: string;
  city: string | null;
  count: number;
}

function routes(legs: readonly Leg[], homeIcao: string | null) {
  const seen = new Map<string, number>();
  for (const l of legs) {
    for (const p of [l.dep, l.arr]) if (p) seen.set(p.icao, (seen.get(p.icao) ?? 0) + 1);
  }
  const hubIcao =
    homeIcao && seen.has(homeIcao)
      ? homeIcao
      : ([...seen.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null);
  const places = new Map<string, AirportRef>();
  for (const l of legs) for (const p of [l.dep, l.arr]) if (p) places.set(p.icao, p);
  const counts = new Map<string, number>();
  for (const l of legs) {
    const other = l.dep?.icao === hubIcao ? l.arr : l.arr?.icao === hubIcao ? l.dep : null;
    if (other && other.icao !== hubIcao) counts.set(other.icao, (counts.get(other.icao) ?? 0) + 1);
  }
  const hub = hubIcao ? (places.get(hubIcao) ?? null) : null;
  const list: Route[] = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([icao, count]) => {
      const p = places.get(icao);
      return { code: placeCode(p ?? null), city: p?.city ?? null, count };
    });
  return { hub, list };
}

function RouteSchematic({ hub, list }: { hub: AirportRef; list: readonly Route[] }) {
  const W = 400;
  const H = 200;
  const shown = list.slice(0, 6);
  const max = Math.max(...shown.map((r) => r.count), 1);
  const hx = 300;
  const hy = H / 2;
  const step = H / (shown.length + 1);
  return (
    <svg
      className="schematic"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label="Route schematic, not to scale"
    >
      {shown.map((r, i) => {
        const y = step * (i + 1);
        const x = 70;
        const cx = (x + hx) / 2;
        const cy = Math.min(y, hy) - 30;
        return (
          <g key={r.code}>
            <path
              className="leg"
              d={`M${x},${y} Q${cx},${cy} ${hx},${hy}`}
              data-faint={r.count / max < 0.34 ? "true" : undefined}
              style={{ strokeWidth: 1 + (r.count / max) * 1.5 }}
            />
            <circle className="node" cx={x} cy={y} r={3} />
            <text x={x - 6} y={y + 4} textAnchor="end">
              {r.code}
            </text>
            <text className="count" x={cx} y={(y + hy) / 2 - 12} textAnchor="middle">
              {r.count}×
            </text>
          </g>
        );
      })}
      <circle className="hub" cx={hx} cy={hy} r={5} />
      <text x={hx + 10} y={hy + 4}>
        {placeLabel(hub)}
      </text>
    </svg>
  );
}

function RoutesPane({ t }: { t: CompanyTravel }) {
  const home = t.aircraft.find((a) => a.homeIcao)?.homeIcao ?? null;
  const { hub, list } = routes(t.legs, home);
  return (
    <Pane
      id="map"
      title="ROUTE SCHEMATIC"
      area="map"
      meta="historical legs"
      foot={
        <>
          <output>Schematic, not to scale</output>
          <span className="right">no live positions</span>
        </>
      }
    >
      {hub && list.length ? (
        <RouteSchematic hub={hub} list={list} />
      ) : (
        <Empty title="No routes yet">
          Routes appear once linked aircraft complete legs with known airports.
        </Empty>
      )}
    </Pane>
  );
}

export async function JetPanes({ symbol }: { symbol: string }) {
  const res = await attempt(companyTravel(getContext(), symbol));
  if (!res.ok)
    return (
      <>
        <PaneError
          id="aircraft"
          title="AIRCRAFT REGISTRY"
          area="aircraft"
          code={res.code}
          source="ADS-B"
        />
        <PaneError id="signals" title="TRAVEL SIGNALS" area="signals" code={res.code} />
        <PaneError id="legs" title="RECENT LEGS" area="legs" code={res.code} />
        <PaneError id="map" title="ROUTE SCHEMATIC" area="map" code={res.code} />
      </>
    );
  const t = res.data;
  if (!t)
    return (
      <>
        <NoCoverage
          id="aircraft"
          title="AIRCRAFT REGISTRY"
          area="aircraft"
          layer="air"
          symbol={symbol}
        />
        <AltSignalsPane layer="air" signals={[]} sources={[]} lastSampleAt={null} />
        <Pane id="legs" title="RECENT LEGS" area="legs" meta="—">
          <Empty title="No legs">
            Flight legs are tracked only for companies with linked aircraft.
          </Empty>
        </Pane>
        <Pane id="map" title="ROUTE SCHEMATIC" area="map" meta="—">
          <Empty title="No routes">Nothing to draw without linked aircraft.</Empty>
        </Pane>
      </>
    );
  return (
    <>
      <AircraftPane symbol={symbol} t={t} />
      <AltSignalsPane
        layer="air"
        signals={t.signals}
        sources={t.sources}
        lastSampleAt={t.coverage.lastSampleAt}
      />
      <LegsPane t={t} />
      <RoutesPane t={t} />
    </>
  );
}

export function JetView({ symbol }: { symbol: string }) {
  return (
    <div className="grid grid-jet">
      <Suspense
        fallback={
          <>
            <PaneSkeleton id="aircraft" title="AIRCRAFT REGISTRY" area="aircraft" lines={4} />
            <PaneSkeleton id="signals" title="TRAVEL SIGNALS" area="signals" />
            <PaneSkeleton id="legs" title="RECENT LEGS" area="legs" lines={12} />
            <PaneSkeleton id="map" title="ROUTE SCHEMATIC" area="map" />
          </>
        }
      >
        <JetPanes symbol={symbol} />
      </Suspense>
    </div>
  );
}
