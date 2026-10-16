import { median } from "@ma/core";
import { CHOKEPOINT_LOITER_MIN } from "@ma/intel";
import { Suspense } from "react";
import { Badge, Chip } from "@/components/ui/chip";
import { DataTable } from "@/components/ui/data-table";
import { Empty } from "@/components/ui/empty";
import { KeyValue } from "@/components/ui/key-value";
import { MiniMap } from "@/components/ui/mini-map";
import { Pane, PaneSkeleton } from "@/components/ui/pane";
import { Sparkline } from "@/components/ui/sparkline";
import { compact, istTime, minutes, num, shortDate } from "@/lib/format";
import { getContext } from "@/server/context";
import { type CompanyLogistics, companyLogistics } from "@/server/queries";
import { attempt, PaneError } from "../shared";
import { AltSignalsPane, NoCoverage } from "./alt";

type Facility = CompanyLogistics["facilities"][number];
type Call = CompanyLogistics["calls"][number];
type Watch = CompanyLogistics["chokepointWatch"][number];

export type CallFilter = "all" | "in" | "out";

export function parseCallFilter(v: string | string[] | undefined): CallFilter {
  const s = Array.isArray(v) ? v[0] : v;
  return s === "in" || s === "out" ? s : "all";
}

function coord(lat: number, lon: number) {
  return `${Math.abs(lat).toFixed(2)}° ${lat >= 0 ? "N" : "S"} · ${Math.abs(lon).toFixed(2)}° ${lon >= 0 ? "E" : "W"}`;
}

function NoAisCoverage({ what }: { what: string }) {
  return (
    <Empty title="Coverage unavailable">
      No AIS samples reached the mapped facilities in the last 7 days, so {what} cannot be assessed.
    </Empty>
  );
}

function FacilitiesPane({ l }: { l: CompanyLogistics }) {
  return (
    <Pane
      id="facilities"
      title="FACILITIES"
      area="facilities"
      meta={`${l.facilities.length} geofences`}
      foot={
        <>
          <output>Company filings · port registry</output>
          <span className="right">
            {l.coverage.factor7d != null
              ? `AIS coverage 7d ${Math.round(l.coverage.factor7d * 100)}%`
              : "coverage n/a"}
          </span>
        </>
      }
    >
      <ul data-rows>
        {l.facilities.map((f: Facility) => {
          const weekly = f.arrivalsWeekly.map((w) => w.count);
          return (
            <li key={f.id} className="broker-card" data-row="">
              <header>
                <b>{f.name}</b>
                <Badge tone="info">{f.kind.toUpperCase()}</Badge>
                {f.exclusive ? <Badge tone="pos">EXCLUSIVE</Badge> : null}
                <span className="right">
                  {weekly.length ? (
                    <Sparkline
                      values={weekly}
                      width={60}
                      height={14}
                      label={`${f.name} weekly arrivals`}
                    />
                  ) : null}
                  <span className="dim">
                    {f.coverage7d > 0
                      ? `${f.activeVessels.length} observed in fence`
                      : "coverage unavailable"}
                  </span>
                </span>
              </header>
              <span className="dim">
                {coord(f.lat, f.lon)} · radius {num(f.radiusKm, 0)} km · {f.role}
              </span>
              <span className="sm">
                {f.commodityIn.length ? (
                  <>
                    <span className="pos">IN</span> {f.commodityIn.join(" · ")}{" "}
                  </>
                ) : null}
                {f.commodityOut.length ? (
                  <>
                    <span className="accent">OUT</span> {f.commodityOut.join(" · ")}
                  </>
                ) : null}
              </span>
            </li>
          );
        })}
      </ul>
      <p className="pane-section dim sm">
        Geofence match + destination text; company attribution remains a proxy.
      </p>
    </Pane>
  );
}

function CallsPane({ l, filter, base }: { l: CompanyLogistics; filter: CallFilter; base: string }) {
  const rows = l.calls.filter((c) =>
    filter === "all"
      ? true
      : filter === "in"
        ? c.cargoDirection === "import"
        : c.cargoDirection === "export",
  );
  const weeks = l.facilities.flatMap((f) => f.arrivalsWeekly);
  const byWeek = new Map<string, number>();
  for (const w of weeks) byWeek.set(w.weekStart, (byWeek.get(w.weekStart) ?? 0) + w.count);
  const series = [...byWeek.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([, v]) => v);
  const last = series.at(-1) ?? null;
  const prior = series.slice(0, -1);
  const base12 = prior.length ? prior.reduce((s, v) => s + v, 0) / prior.length : null;
  const dwell = median(
    rows
      .filter((c) => c.endedBy === "exit")
      .map((c) => c.dwellMin)
      .filter((d): d is number => d != null),
  );
  return (
    <Pane
      id="calls"
      title="VESSEL CALLS"
      area="calls"
      meta={`${rows.length} calls`}
      tabs={
        <span className="row">
          {(["all", "in", "out"] as const).map((k) => (
            <Chip key={k} href={`${base}${k === "all" ? "" : `?calls=${k}`}`} active={filter === k}>
              {{ all: "ALL CALLS", in: "INBOUND", out: "OUTBOUND" }[k]}
            </Chip>
          ))}
        </span>
      }
      foot={
        <>
          <output>AISStream · sampled positions</output>
          <span className="right">cargo quantities estimated</span>
        </>
      }
    >
      <div className="tiles">
        <div className="tile">
          <span className="lbl">Arrivals / week</span>
          <span className="val">{l.coverage.factor7d >= 0.2 ? (last ?? "—") : "—"}</span>
          <span className="sub">
            {l.coverage.factor7d < 0.2
              ? "insufficient AIS coverage"
              : base12 != null
                ? `/ ${num(base12, 1)} observed base`
                : "no baseline"}
          </span>
        </div>
        <div className="tile">
          <span className="lbl">Median dwell</span>
          <span className="val">{minutes(dwell)}</span>
          <span className="sub">{rows.length} calls</span>
        </div>
        <div className="tile">
          <span className="lbl">Coverage 24h</span>
          <span className="val">
            {l.coverage.windows24h
              ? `${Math.round((l.coverage.windowsWithData24h / l.coverage.windows24h) * 100)}%`
              : "—"}
          </span>
          <span className="sub">
            {l.coverage.windowsWithData24h}/{l.coverage.windows24h} windows
          </span>
        </div>
      </div>
      <DataTable<Call>
        label="Vessel calls"
        rows={rows}
        rowKey={(c) => c.id}
        columns={[
          {
            key: "n",
            header: "VESSEL",
            cell: (c) => <span className="truncate">{c.name ?? String(c.mmsi)}</span>,
          },
          { key: "t", header: "TYPE", width: "sm", cell: (c) => c.sizeClass ?? c.class },
          {
            key: "a",
            header: "ARRIVED · IST",
            width: "md",
            sortable: true,
            sortValue: (c) => new Date(c.enteredAt).getTime(),
            cell: (c) => `${shortDate(c.enteredAt)} ${istTime(c.enteredAt)}`,
          },
          {
            key: "d",
            header: "DWELL",
            width: "sm",
            align: "right",
            sortable: true,
            sortValue: (c) => c.dwellMin,
            cell: (c) =>
              c.endedBy === "timeout" ? (
                <span className="dim">≥{minutes(c.dwellMin)}</span>
              ) : c.leftAt ? (
                minutes(c.dwellMin)
              ) : (
                <span className="accent">last seen in port</span>
              ),
            title: (c) =>
              c.endedBy === "timeout"
                ? "Coverage ended; departure was not observed"
                : "Observed geofence dwell",
          },
          {
            key: "c",
            header: "CARGO PROXY",
            width: "lg",
            priority: 2,
            cell: (c) =>
              c.cargoProxy.commodity
                ? `${c.cargoProxy.commodity}${c.cargoProxy.bbl ? ` · ~${compact(c.cargoProxy.bbl)} bbl` : ""}`
                : "—",
          },
          { key: "f", header: "FACILITY", width: "md", priority: 3, cell: (c) => c.facilitySlug },
        ]}
        empty={
          l.coverage.factor7d > 0 ? (
            <Empty title="No calls">No vessel has entered a mapped geofence in the window.</Empty>
          ) : (
            <NoAisCoverage what="vessel calls" />
          )
        }
      />
    </Pane>
  );
}

function CargoProxy({ rows, none }: { rows: Watch[]; none: string }) {
  if (!rows.length) return <span className="dim">{none}</span>;
  const valued = rows.flatMap((r) => (r.estValueCr != null ? [r.estValueCr] : []));
  if (!valued.length) return <span className="muted">unavailable</span>;
  return (
    <>
      <b className="accent">
        ~₹
        {num(
          valued.reduce((s, v) => s + v, 0),
          0,
        )}{" "}
        Cr
      </b>
      {valued.length < rows.length ? (
        <span className="dim">
          {" "}
          partial · {valued.length}/{rows.length} valued
        </span>
      ) : null}
    </>
  );
}

function orList(names: string[]) {
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} or ${names.at(-1)}` : names.join("");
}

function ChokepointPane({ l }: { l: CompanyLogistics }) {
  const rows = [...l.chokepointWatch].sort((a, b) => b.loiterMin - a.loiterMin);
  const loitering = rows.filter((r) => r.loitering);
  const moving = rows.filter((r) => !r.loitering);
  const zones = l.coverage.chokepoints;
  const covered = zones.filter((z) => z.covered);
  const threshold = minutes(CHOKEPOINT_LOITER_MIN);
  const basis = "Class-typical cargo × Brent/USDINR; not a manifest value";
  return (
    <Pane
      id="chokepoints"
      title="CHOKEPOINT EXPOSURE"
      area="chokepoints"
      meta={`destination-linked · coverage ${covered.length}/${zones.length} zones`}
      foot={<output>Association is not confirmed ownership</output>}
    >
      {rows.length ? (
        <>
          <KeyValue
            label="Chokepoint cargo"
            groups={[
              {
                items: [
                  {
                    label: "Delayed cargo proxy",
                    title: `${basis}; vessels idle ≥ ${threshold}`,
                    value: <CargoProxy rows={loitering} none="none loitering" />,
                  },
                  {
                    label: "In transit",
                    title: `${basis}; vessels idle < ${threshold}`,
                    value: <CargoProxy rows={moving} none="none moving" />,
                  },
                  {
                    label: "Vessels loitering",
                    title: `Idle ≥ ${threshold} inside a chokepoint`,
                    value: String(loitering.length),
                  },
                  { label: "Vessels moving", value: String(moving.length) },
                ],
              },
            ]}
          />
          <DataTable<Watch>
            label="Chokepoint watch"
            rows={rows}
            rowKey={(r) => r.mmsi}
            columns={[
              {
                key: "v",
                header: "BOUND FOR / VESSEL",
                cell: (r) => (
                  <span className="truncate">
                    {r.destinationFacilitySlug ?? r.destination ?? "?"} · {r.name ?? r.mmsi}
                  </span>
                ),
              },
              { key: "z", header: "ZONE", width: "sm", cell: (r) => r.chokepoint },
              {
                key: "i",
                header: "IDLE",
                width: "xs",
                align: "right",
                sortable: true,
                sortValue: (r) => r.loiterMin,
                cell: (r) => (
                  <span
                    className={r.loitering ? "accent" : "dim"}
                    title={r.loitering ? "loitering" : "moving"}
                  >
                    {minutes(r.loiterMin)}
                  </span>
                ),
              },
              {
                key: "val",
                header: "VALUE PROXY",
                width: "num",
                align: "right",
                sortable: true,
                sortValue: (r) => r.estValueCr,
                cell: (r) => (r.estValueCr != null ? `~₹${num(r.estValueCr, 0)} Cr` : "—"),
              },
            ]}
          />
        </>
      ) : covered.length ? (
        <Empty title="No observed chokepoint loitering">
          No fresh AIS observation shows an inbound vessel for a mapped facility idling at{" "}
          {orList(covered.map((z) => z.name))}.
          {covered.length < zones.length
            ? ` Coverage unavailable at ${zones.length - covered.length} other zones.`
            : null}
        </Empty>
      ) : (
        <Empty title="No observed loitering">
          No observed loitering; chokepoint coverage unavailable in the last 7 days, so absence
          cannot be confirmed.
        </Empty>
      )}
    </Pane>
  );
}

function PositionsPane({ l }: { l: CompanyLogistics }) {
  const lastTs =
    l.positionsForMap
      .map((p) => p.ts)
      .sort()
      .at(-1) ?? null;
  return (
    <Pane
      id="map"
      title="LINKED VESSEL POSITIONS"
      area="map"
      meta={lastTs ? istTime(lastTs) : "no fixes"}
      foot={
        <>
          <output>Not to scale · sampled positions</output>
          <span className="right">{l.positionsForMap.length} fixes</span>
        </>
      }
    >
      <MiniMap
        label="Facilities and recent vessel positions"
        areas={l.facilities.map((f) => ({
          key: f.slug,
          lat: f.lat,
          lon: f.lon,
          radiusKm: f.radiusKm,
          label: f.name,
        }))}
        points={l.positionsForMap.map((p) => ({
          key: `${p.mmsi}-${p.ts}`,
          lat: p.lat,
          lon: p.lon,
          kind: p.class,
          label: `${p.mmsi} · ${p.linkage} · ${p.class} · ${istTime(p.ts)}`,
        }))}
      />
    </Pane>
  );
}

export async function ShipPanes({ symbol, filter }: { symbol: string; filter: CallFilter }) {
  const res = await attempt(companyLogistics(getContext(), symbol));
  const titles = [
    ["facilities", "FACILITIES"],
    ["signals", "LOGISTICS SIGNALS"],
    ["calls", "VESSEL CALLS"],
    ["chokepoints", "CHOKEPOINT EXPOSURE"],
    ["map", "POSITION SCHEMATIC"],
  ] as const;
  if (!res.ok)
    return (
      <>
        {titles.map(([id, title]) => (
          <PaneError key={id} id={id} title={title} area={id} code={res.code} source="AIS" />
        ))}
      </>
    );
  const l = res.data;
  if (!l)
    return (
      <>
        <NoCoverage
          id="facilities"
          title="FACILITIES"
          area="facilities"
          layer="sea"
          symbol={symbol}
        />
        <AltSignalsPane layer="sea" signals={[]} sources={[]} lastSampleAt={null} />
        {titles.slice(2).map(([id, title]) => (
          <Pane key={id} id={id} title={title} area={id} meta="—">
            <Empty title="Not covered">
              Logistics data is tracked only for companies with mapped facilities.
            </Empty>
          </Pane>
        ))}
      </>
    );
  return (
    <>
      <FacilitiesPane l={l} />
      <AltSignalsPane
        layer="sea"
        signals={l.signals}
        sources={l.sources}
        lastSampleAt={l.coverage.lastSampleAt}
      />
      <CallsPane l={l} filter={filter} base={`/c/${encodeURIComponent(symbol)}/ship`} />
      <ChokepointPane l={l} />
      <PositionsPane l={l} />
    </>
  );
}

export function ShipView({ symbol, filter }: { symbol: string; filter: CallFilter }) {
  return (
    <div className="grid grid-ship">
      <Suspense
        fallback={
          <>
            <PaneSkeleton id="facilities" title="FACILITIES" area="facilities" lines={4} />
            <PaneSkeleton id="signals" title="LOGISTICS SIGNALS" area="signals" />
            <PaneSkeleton id="calls" title="VESSEL CALLS" area="calls" lines={12} />
            <PaneSkeleton id="chokepoints" title="CHOKEPOINT EXPOSURE" area="chokepoints" />
            <PaneSkeleton id="map" title="POSITION SCHEMATIC" area="map" />
          </>
        }
      >
        <ShipPanes symbol={symbol} filter={filter} />
      </Suspense>
    </div>
  );
}
