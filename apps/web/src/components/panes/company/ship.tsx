import { median } from "@ma/intel";
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
                  <span className="dim">{f.activeVessels.length} in fence</span>
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
        ? c.cargoDirection !== "export"
        : c.cargoDirection === "export",
  );
  const weeks = l.facilities.flatMap((f) => f.arrivalsWeekly);
  const byWeek = new Map<string, number>();
  for (const w of weeks) byWeek.set(w.weekStart, (byWeek.get(w.weekStart) ?? 0) + w.count);
  const series = [...byWeek.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([, v]) => v);
  const last = series.at(-1) ?? null;
  const prior = series.slice(0, -1);
  const base12 = prior.length ? prior.reduce((s, v) => s + v, 0) / prior.length : null;
  const dwell = median(rows.map((c) => c.dwellMin).filter((d): d is number => d != null));
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
          <span className="val">{last ?? "—"}</span>
          <span className="sub">{base12 != null ? `/ ${num(base12, 1)} base` : "no baseline"}</span>
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
            cell: (c) => (c.leftAt ? minutes(c.dwellMin) : <span className="accent">in port</span>),
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

function ChokepointPane({ l }: { l: CompanyLogistics }) {
  const rows = l.chokepointWatch;
  const valued = rows.flatMap((r) => (r.estValueCr != null ? [r.estValueCr] : []));
  const total = valued.reduce((s, v) => s + v, 0);
  return (
    <Pane
      id="chokepoints"
      title="CHOKEPOINT EXPOSURE"
      area="chokepoints"
      meta="destination-linked"
      foot={<output>Association is not confirmed ownership</output>}
    >
      {rows.length ? (
        <>
          <KeyValue
            label="Delayed cargo"
            groups={[
              {
                items: [
                  {
                    label: "Delayed cargo proxy",
                    title: "Class-typical cargo × Brent/USDINR; not a manifest value",
                    value: valued.length ? (
                      <>
                        <b className="accent">~₹{num(total, 0)} Cr</b>
                        {valued.length < rows.length ? (
                          <span className="dim">
                            {" "}
                            partial · {valued.length}/{rows.length} valued
                          </span>
                        ) : null}
                      </>
                    ) : (
                      <span className="muted">unavailable</span>
                    ),
                  },
                  { label: "Vessels loitering", value: String(rows.length) },
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
                  <span className={r.loiterMin >= 24 * 60 ? "accent" : ""}>
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
      ) : l.coverage.factor7d > 0 ? (
        <Empty title="No chokepoint loitering">
          No inbound vessel bound for a mapped facility is idling at Hormuz, Bab-el-Mandeb or
          Malacca.
        </Empty>
      ) : (
        <NoAisCoverage what="chokepoint exposure" />
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
      title="POSITION SCHEMATIC"
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
          label: `${p.mmsi} · ${p.class} · ${istTime(p.ts)}`,
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
