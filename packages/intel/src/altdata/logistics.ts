import { type Db, sql } from "@ma/db";
import {
  type AltdataEventInput,
  clamp,
  DAY_MS,
  emitAltdataEvents,
  fitRead,
  iso,
  isoDate,
  meanStd,
  median,
  round,
  weekCounts,
  writeAltdataSignals,
  zScore,
} from "./common.js";
import {
  type AltdataEvidence,
  type AltdataSignal,
  LOGISTICS_MODEL_VERSION,
  LOGISTICS_SIGNAL_KINDS,
  type LogisticsSignalKind,
} from "./types.js";

export const MIN_COVERAGE = 0.2;
export const LOITER_MIN = 360;
export const FILL_FACTOR = 0.95;
export const PRODUCT_CRACK = 1.15;
export const VALUE_BAND = 0.25;
export const CARGO_VALUE_BASIS = "dwt_est × 0.95 fill × Brent × USDINR";

export const TANKER_BBL: Record<string, number> = {
  VLCC: 2_000_000,
  Suezmax: 1_000_000,
  "Aframax/LR2": 700_000,
  "Panamax/LR1": 500_000,
  MR: 300_000,
  "Small tanker": 100_000,
};

const PRODUCT_SIZES = new Set(["MR", "Small tanker", "Panamax/LR1"]);

export const LOGISTICS_KIND_BASE: Record<LogisticsSignalKind, number> = {
  logistics_arrivals_7d: 1,
  logistics_throughput_proxy: 0.7,
  logistics_chokepoint_exposure: 0.6,
  logistics_port_congestion: 0.6,
  logistics_export_departures_7d: 0.6,
  logistics_fleet_activity: 0.8,
  logistics_coverage: 1,
};

const COMMODITY_CLASSES: Record<string, string[]> = {
  crude: ["tanker"],
  products: ["tanker"],
  diesel: ["tanker"],
  jet: ["tanker"],
  naphtha: ["tanker"],
  chemicals: ["tanker"],
  phosphoric_acid: ["tanker"],
  ammonia: ["gas"],
  lng: ["gas"],
  lpg: ["gas"],
  coal: ["cargo"],
  iron_ore: ["cargo"],
  copper_concentrate: ["cargo"],
  copper: ["cargo", "container"],
  fertilizer: ["cargo"],
  steel: ["cargo"],
  polymers: ["container"],
  containers: ["container"],
};

export interface Prices {
  brent: number;
  usdinr: number;
}

export interface CargoValue {
  commodity: string;
  cargoBbl: number | null;
  estValueUsd: number | null;
  estValueCr: number | null;
  basis: string;
}

export function cargoValueEstimate(
  vessel: { class: string; sizeClass: string | null; product?: boolean },
  prices: Prices | null,
): CargoValue {
  const bbl =
    vessel.class === "tanker" && vessel.sizeClass ? (TANKER_BBL[vessel.sizeClass] ?? null) : null;
  const product =
    vessel.product ?? (vessel.sizeClass ? PRODUCT_SIZES.has(vessel.sizeClass) : false);
  const commodity =
    vessel.class === "tanker"
      ? product
        ? "refined products"
        : "crude"
      : vessel.class === "gas"
        ? "LNG/LPG"
        : vessel.class === "cargo"
          ? "dry bulk"
          : vessel.class === "container"
            ? "containers"
            : "unknown";
  if (bbl === null || !prices) {
    return {
      commodity,
      cargoBbl: bbl !== null ? bbl * FILL_FACTOR : null,
      estValueUsd: null,
      estValueCr: null,
      basis: "qualitative",
    };
  }
  const cargoBbl = bbl * FILL_FACTOR;
  const estValueUsd = cargoBbl * prices.brent * (product ? PRODUCT_CRACK : 1);
  return {
    commodity,
    cargoBbl,
    estValueUsd: Math.round(estValueUsd),
    estValueCr: round((estValueUsd * prices.usdinr) / 1e7, 1),
    basis: CARGO_VALUE_BASIS,
  };
}

export function coverageFactor(windows: number, windowsWithData: number): number {
  return windows > 0 ? round(clamp(windowsWithData / windows, 0, 1), 3) : 0;
}

export function commodityClasses(commodities: readonly string[]): string[] {
  return [...new Set(commodities.flatMap((c) => COMMODITY_CLASSES[c] ?? []))];
}

export interface LogisticsFacility {
  id: number;
  slug: string;
  name: string;
  kind: string;
  role: string;
  exclusive: boolean;
  commodityIn: string[];
  commodityOut: string[];
}

export interface ZoneCoverage {
  zone: string;
  windows: number;
  windowsWithData: number;
  lastDataDay: string | null;
  firstDayMs: number | null;
}

export interface LogisticsCall {
  id: number;
  facilityId: number;
  mmsi: number;
  name: string | null;
  class: string;
  sizeClass: string | null;
  enteredMs: number;
  leftMs: number | null;
  dwellMin: number | null;
  cargoDirection: string | null;
}

export interface InboundVessel {
  mmsi: number;
  name: string | null;
  class: string;
  sizeClass: string | null;
  dwtEst: number | null;
  chokepoint: string;
  loiterMin: number;
  destination: string | null;
  destinationFacilityId: number;
  enteredMs: number;
  transitId: number;
}

export interface WaitingVessel {
  facilityId: number;
  callId: number;
  mmsi: number;
  name: string | null;
  class: string;
  waitingHours: number;
}

export interface FleetVessel {
  imo: number;
  name: string;
  mmsi: number | null;
  class: string | null;
  lastSeenMs: number | null;
  sogKt: number | null;
}

export interface LogisticsInput {
  companyId: number;
  label: string;
  asOf: string;
  nowMs: number;
  facilities: LogisticsFacility[];
  coverage: Map<string, ZoneCoverage>;
  chokepointZones: string[];
  calls: LogisticsCall[];
  inbound: InboundVessel[];
  waiting: WaitingVessel[];
  fleet: FleetVessel[] | null;
  prices: Prices | null;
}

export interface LogisticsResult {
  signals: AltdataSignal[];
  events: AltdataEventInput[];
}

export function linkageConfidence(f: Pick<LogisticsFacility, "exclusive" | "role">): number {
  if (f.exclusive) return 0.9;
  return f.role === "user" ? 0.5 : 0.7;
}

function callEvidence(c: LogisticsCall, slug: string): AltdataEvidence {
  return {
    kind: "call",
    id: c.id,
    label: `${c.name ?? c.mmsi} at ${slug}`,
    at: iso(c.leftMs ?? c.enteredMs),
  };
}

function pct(v: number): string {
  const p = Math.round(v * 100);
  return `${p >= 0 ? "+" : ""}${p}%`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function crore(v: number): string {
  return v >= 1000 ? `${Math.round(v).toLocaleString("en-IN")}` : `${round(v, 0)}`;
}

export function computeLogisticsSignals(input: LogisticsInput): LogisticsResult {
  const { nowMs, asOf } = input;
  const from7 = nowMs - 7 * DAY_MS;
  const window7 = { from: iso(from7), to: iso(nowMs) };
  const out: AltdataSignal[] = [];
  const events: AltdataEventInput[] = [];
  const push = (
    kind: LogisticsSignalKind,
    value: number,
    read: string,
    confidence: number,
    evidence: AltdataEvidence[],
    extra: Record<string, unknown>,
    baseline?: { from: string; to: string; mean: number; std: number },
  ) => {
    out.push({
      kind,
      asOf,
      value,
      inputs: {
        read: fitRead(read),
        confidence: round(clamp(confidence, 0, 1), 3),
        evidence: evidence.slice(0, 12),
        window: window7,
        ...(baseline ? { baseline } : {}),
        ...extra,
      },
    });
  };
  const facilityById = new Map(input.facilities.map((f) => [f.id, f]));
  const cov = (f: LogisticsFacility) => input.coverage.get(`facility:${f.id}`);
  const covFactor = (f: LogisticsFacility) => {
    const c = cov(f);
    return c ? coverageFactor(c.windows, c.windowsWithData) : 0;
  };
  const historyWeeks = (f: LogisticsFacility) => {
    const first = cov(f)?.firstDayMs ?? null;
    return first === null
      ? 0
      : Math.min(8, Math.max(0, Math.floor((nowMs - first) / (7 * DAY_MS)) - 1));
  };
  const eligible = input.facilities.filter((f) => covFactor(f) >= MIN_COVERAGE);
  const factors = input.facilities.map(covFactor);
  const companyCoverage = factors.length
    ? round(factors.reduce((s, v) => s + v, 0) / factors.length, 3)
    : 0;
  const callsBy = new Map<number, LogisticsCall[]>();
  for (const c of input.calls) {
    const list = callsBy.get(c.facilityId) ?? [];
    list.push(c);
    callsBy.set(c.facilityId, list);
  }

  if (eligible.length) {
    const rows = eligible.map((f) => {
      const recent = (callsBy.get(f.id) ?? []).filter((c) => c.enteredMs >= from7);
      const byClass = { tanker: 0, gas: 0, cargo: 0, container: 0 };
      for (const c of recent) if (c.class in byClass) byClass[c.class as keyof typeof byClass]++;
      const dwell = recent.map((c) => c.dwellMin).filter((d): d is number => d !== null);
      return { f, recent, byClass, medianDwellMin: median(dwell) };
    });
    const total = rows.reduce((s, r) => s + r.recent.length, 0);
    const top = [...rows].sort(
      (a, b) => b.recent.length - a.recent.length,
    )[0] as (typeof rows)[number];
    const conf = Math.max(...eligible.map((f) => linkageConfidence(f) * covFactor(f)));
    push(
      "logistics_arrivals_7d",
      total,
      total
        ? `${plural(total, "vessel arrival")} in 7 d across ${plural(eligible.length, "covered facility")} (${top.f.name}: ${top.recent.length}); AIS-derived, coverage ${Math.round(companyCoverage * 100)}%.`
        : `No vessel arrivals observed in 7 d at ${plural(eligible.length, "covered facility")}; AIS coverage ${Math.round(companyCoverage * 100)}%.`,
      conf * LOGISTICS_KIND_BASE.logistics_arrivals_7d,
      rows.flatMap((r) => r.recent.map((c) => callEvidence(c, r.f.slug))),
      {
        facilities: rows.map((r) => ({
          facilityId: r.f.id,
          slug: r.f.slug,
          arrivals: r.recent.length,
          byClass: r.byClass,
          medianDwellMin: r.medianDwellMin,
        })),
      },
    );

    const throughput = eligible
      .map((f) => {
        const classes = commodityClasses(f.commodityIn);
        const weeks = historyWeeks(f);
        if (!classes.length || weeks < 4) return null;
        const matched = (callsBy.get(f.id) ?? []).filter((c) => classes.includes(c.class));
        const recent = matched.filter((c) => c.enteredMs >= from7);
        const weekly = weekCounts(
          matched.map((c) => c.enteredMs),
          from7,
          8,
        ).slice(8 - weeks);
        const { mean, std } = meanStd(weekly);
        if (mean <= 0) return null;
        return { f, classes, recent, weeks, mean, std, z: zScore(recent.length, mean, std) };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .sort((a, b) => b.mean - a.mean);
    const tp = throughput[0];
    if (tp) {
      const ratio = tp.recent.length / tp.mean;
      const cls = tp.classes[0] ?? "vessel";
      const commodity = tp.f.commodityIn[0] ?? "cargo";
      push(
        "logistics_throughput_proxy",
        round(ratio, 3),
        `${tp.recent.length} ${cls} arrivals/wk vs ${round(tp.mean, 1)} baseline (${pct(ratio - 1)}) at ${tp.f.name} — ${ratio < 1 ? "softer" : "firmer"} inbound ${commodity}; sampling gaps and maintenance are alternative explanations.`,
        linkageConfidence(tp.f) * covFactor(tp.f) * LOGISTICS_KIND_BASE.logistics_throughput_proxy,
        tp.recent.map((c) => callEvidence(c, tp.f.slug)),
        {
          facilityId: tp.f.id,
          arrivals: tp.recent.length,
          z: round(tp.z, 2),
          calls: tp.recent.slice(0, 20).map((c) => ({
            id: c.id,
            mmsi: c.mmsi,
            name: c.name,
            class: c.class,
            sizeClass: c.sizeClass,
            enteredAt: iso(c.enteredMs),
            dwellMin: c.dwellMin,
            cargoDirection: c.cargoDirection,
          })),
        },
        {
          from: iso(from7 - tp.weeks * 7 * DAY_MS),
          to: iso(from7),
          mean: round(tp.mean, 2),
          std: round(tp.std, 2),
        },
      );
    }

    const congestion = eligible
      .map((f) => {
        const waiting = input.waiting.filter((w) => w.facilityId === f.id);
        const days = Math.min(56, historyWeeks(f) * 7 + 7);
        const closed = (callsBy.get(f.id) ?? []).filter(
          (c) => c.leftMs !== null && c.leftMs >= nowMs - days * DAY_MS && c.dwellMin !== null,
        );
        const excess = closed.reduce((s, c) => s + Math.max(0, (c.dwellMin as number) - 1440), 0);
        const baselineWaiting = days > 0 ? round(excess / (days * 1440), 2) : 0;
        return { f, waiting, baselineWaiting };
      })
      .filter((x) => x.waiting.length > 0)
      .sort((a, b) => b.waiting.length - a.waiting.length);
    const cg = congestion[0];
    if (cg) {
      push(
        "logistics_port_congestion",
        cg.waiting.length,
        `${plural(cg.waiting.length, "vessel")} waiting > 24 h at ${cg.f.name} vs ${cg.baselineWaiting} normal — congestion/demurrage risk; AIS status can lag.`,
        linkageConfidence(cg.f) * covFactor(cg.f) * LOGISTICS_KIND_BASE.logistics_port_congestion,
        cg.waiting.map((w) => ({
          kind: "call" as const,
          id: w.callId,
          label: `${w.name ?? w.mmsi} waiting ${Math.round(w.waitingHours)} h`,
          at: iso(nowMs),
        })),
        {
          facilityId: cg.f.id,
          waiting: cg.waiting.map((w) => ({
            mmsi: w.mmsi,
            name: w.name,
            class: w.class,
            waitingHours: round(w.waitingHours, 1),
          })),
          baselineWaiting: cg.baselineWaiting,
        },
      );
      if (cg.waiting.length >= Math.max(3, 2 * cg.baselineWaiting)) {
        events.push({
          layer: "sea",
          kind: "sea.congestion",
          companyId: input.companyId,
          facilityId: cg.f.id,
          occurredAt: nowMs,
          headline: `${plural(cg.waiting.length, "vessel")} waiting > 24 h at ${cg.f.name} (${input.label}) vs ${cg.baselineWaiting} normal`,
          detail: {
            facilitySlug: cg.f.slug,
            waiting: cg.waiting.length,
            baseline: cg.baselineWaiting,
          },
          severity: 2,
          dedupeKey: `logistics:${input.companyId}:congestion:${cg.f.id}:${asOf}`,
        });
      }
    }

    const exports = eligible
      .filter((f) => f.commodityOut.length > 0)
      .map((f) => {
        const weeks = historyWeeks(f);
        const exp = (callsBy.get(f.id) ?? []).filter(
          (c) => c.leftMs !== null && c.cargoDirection === "export",
        );
        const recent = exp.filter((c) => (c.leftMs as number) >= from7);
        const weekly = weekCounts(
          exp.map((c) => c.leftMs as number),
          from7,
          8,
        ).slice(8 - weeks);
        const { mean, std } = meanStd(weekly);
        return { f, weeks, recent, mean, std };
      })
      .filter((x) => x.recent.length > 0 || x.weeks >= 4)
      .sort((a, b) => b.recent.length - a.recent.length);
    const ex = exports[0];
    if (ex) {
      const z = ex.weeks >= 4 ? round(zScore(ex.recent.length, ex.mean, ex.std), 2) : null;
      const dir =
        z === null ? "with no baseline yet" : z >= 0 ? "up vs baseline" : "down vs baseline";
      const what = ex.f.commodityOut.includes("steel") ? "Steel" : "Product";
      push(
        "logistics_export_departures_7d",
        ex.recent.length,
        `${what} departures at ${ex.f.name}: ${ex.recent.length} in 7 d, ${dir}${z === null ? "" : ` (${round(ex.mean, 1)}/wk)`}; direction inferred from draught change.`,
        linkageConfidence(ex.f) *
          covFactor(ex.f) *
          LOGISTICS_KIND_BASE.logistics_export_departures_7d,
        ex.recent.map((c) => callEvidence(c, ex.f.slug)),
        {
          facilityId: ex.f.id,
          departures: ex.recent.length,
          baseline: ex.weeks >= 4 ? round(ex.mean, 2) : null,
          z,
          calls: ex.recent.slice(0, 20).map((c) => ({
            id: c.id,
            mmsi: c.mmsi,
            name: c.name,
            class: c.class,
            leftAt: iso(c.leftMs as number),
          })),
        },
      );
    }
  }

  const chokeCov = input.chokepointZones.map((z) => {
    const c = input.coverage.get(z);
    return { zone: z, factor: c ? coverageFactor(c.windows, c.windowsWithData) : 0, c };
  });
  const anyChokeCoverage = chokeCov.some((c) => c.factor >= MIN_COVERAGE);
  if (input.inbound.length || anyChokeCoverage) {
    const rows = input.inbound.map((v) => {
      const dest = facilityById.get(v.destinationFacilityId);
      const product = v.class === "tanker" && !!dest && !dest.commodityIn.includes("crude");
      const value = cargoValueEstimate(
        { class: v.class, sizeClass: v.sizeClass, product },
        input.prices,
      );
      return { v, dest, value };
    });
    const total = rows.reduce((s, r) => s + (r.value.estValueCr ?? 0), 0);
    const valued = rows.some((r) => r.value.estValueCr !== null);
    const idle = rows.filter((r) => r.v.loiterMin >= LOITER_MIN);
    const focus = idle.length ? idle : rows;
    const first = focus[0];
    let read: string;
    if (!first) {
      read =
        "No inbound vessels for this company's facilities seen loitering or inside a watched chokepoint.";
    } else {
      const sizes = [...new Set(focus.map((r) => r.v.sizeClass ?? r.v.class))].join("/");
      const hours = Math.round(Math.max(...focus.map((r) => r.v.loiterMin)) / 60);
      const where = first.v.chokepoint.replace(/_/g, " ");
      const state = idle.length ? `idle at ${where} ~${hours} h` : `inside ${where}`;
      const valueText = valued
        ? `, ≈ ₹${crore(total)} Cr of ${first.value.commodity} ${idle.length ? "delayed" : "in transit"} — working-capital timing risk, not a loss`
        : "";
      read = `${focus.length} inbound ${sizes} ${state}${valueText}; cargo and destination inferred.`;
    }
    const linkConf = rows.length
      ? Math.max(...rows.map((r) => (r.dest ? linkageConfidence(r.dest) : 0.4)))
      : 0.5;
    push(
      "logistics_chokepoint_exposure",
      rows.length,
      read,
      linkConf * 0.7 * LOGISTICS_KIND_BASE.logistics_chokepoint_exposure,
      rows.map((r) => ({
        kind: "transit" as const,
        id: r.v.transitId,
        label: `${r.v.name ?? r.v.mmsi} at ${r.v.chokepoint}`,
        at: iso(r.v.enteredMs),
      })),
      {
        vessels: rows.map((r) => ({
          mmsi: r.v.mmsi,
          name: r.v.name,
          class: r.v.class,
          sizeClass: r.v.sizeClass,
          chokepoint: r.v.chokepoint,
          loiterMin: r.v.loiterMin,
          destination: r.v.destination,
          destinationFacilitySlug: r.dest?.slug ?? null,
          dwtEst: r.v.dwtEst,
          cargoBbl: r.value.cargoBbl,
          estValueUsd: r.value.estValueUsd,
          estValueCr: r.value.estValueCr,
        })),
        totalEstValueCr: valued ? round(total, 1) : null,
        valueRange: valued
          ? { low: round(total * (1 - VALUE_BAND), 1), high: round(total * (1 + VALUE_BAND), 1) }
          : null,
        basis: valued ? CARGO_VALUE_BASIS : "qualitative",
        prices: input.prices,
      },
    );
    if (idle.length) {
      events.push({
        layer: "sea",
        kind: "sea.chokepoint_exposure",
        companyId: input.companyId,
        occurredAt: nowMs,
        headline: `${input.label}: ${read}`,
        detail: {
          vessels: idle.map((r) => r.v.mmsi),
          totalEstValueCr: valued ? round(total, 1) : null,
        },
        severity: valued ? 3 : 2,
        dedupeKey: `logistics:${input.companyId}:choke:${asOf}`,
      });
    }
  }

  if (input.fleet?.length) {
    const fleetSize = input.fleet.length;
    const seen = input.fleet.filter((v) => v.lastSeenMs !== null && v.lastSeenMs >= from7);
    const moving = seen.filter((v) => (v.sogKt ?? 0) > 3);
    const share = seen.length ? round(moving.length / seen.length, 3) : 0;
    const read =
      seen.length < fleetSize
        ? `Only ${seen.length}/${fleetSize} owned vessels observed in 7 d${seen.length ? `, ${moving.length} moving` : ""} — AIS coverage limits this read.`
        : `${moving.length}/${seen.length} owned vessels moving in the last 7 d sample.`;
    push(
      "logistics_fleet_activity",
      share,
      read,
      0.95 *
        (fleetSize ? seen.length / fleetSize : 0) *
        LOGISTICS_KIND_BASE.logistics_fleet_activity,
      seen.map((v) => ({
        kind: "vessel" as const,
        id: v.mmsi ?? v.imo,
        label: v.name,
        at: iso(v.lastSeenMs as number),
      })),
      {
        fleetSize,
        seen7d: seen.length,
        moving: moving.length,
        anchored: seen.length - moving.length,
        vessels: input.fleet.slice(0, 60).map((v) => ({
          imo: v.imo,
          name: v.name,
          mmsi: v.mmsi,
          class: v.class,
          lastSeenAt: v.lastSeenMs !== null ? iso(v.lastSeenMs) : null,
          sogKt: v.sogKt,
        })),
      },
    );
  }

  if (input.facilities.length) {
    const facilityRows = input.facilities.map((f) => {
      const c = cov(f);
      return {
        facilityId: f.id,
        slug: f.slug,
        windows: c?.windows ?? 0,
        windowsWithData: c?.windowsWithData ?? 0,
        factor: covFactor(f),
        lastSampleAt: c?.lastDataDay ?? null,
      };
    });
    const best = [...facilityRows].sort(
      (a, b) => b.factor - a.factor,
    )[0] as (typeof facilityRows)[number];
    const bestName = facilityById.get(best.facilityId)?.name ?? best.slug;
    push(
      "logistics_coverage",
      companyCoverage,
      companyCoverage > 0
        ? `AIS coverage ${Math.round(companyCoverage * 100)}% of collection windows across ${plural(input.facilities.length, "facility")} (best: ${bestName} ${Math.round(best.factor * 100)}%).`
        : `No AIS coverage in the last 7 days at ${plural(input.facilities.length, "watched facility")} — quiet is not evidence of low activity.`,
      1,
      [],
      {
        facilities: facilityRows,
        chokepoints: chokeCov.map((c) => ({
          slug: c.zone.replace(/^chokepoint:/, ""),
          windows: c.c?.windows ?? 0,
          windowsWithData: c.c?.windowsWithData ?? 0,
          factor: c.factor,
        })),
      },
    );
  }

  return { signals: out, events };
}

type FacilityLinkRow = {
  companyId: number;
  id: number;
  slug: string;
  name: string;
  kind: string;
  role: string;
  exclusive: boolean;
  commodityIn: string[];
  commodityOut: string[];
};

type CoverageRow = {
  zone: string;
  windows: number;
  windowsWithData: number;
  lastDataDay: string | null;
  firstDayMs: number | null;
};

type CallRow = {
  id: number;
  facilityId: number;
  mmsi: number;
  name: string | null;
  class: string;
  sizeClass: string | null;
  enteredMs: number;
  leftMs: number | null;
  dwellMin: number | null;
  cargoDirection: string | null;
};

type InboundRow = {
  transitId: number;
  mmsi: number;
  name: string | null;
  class: string;
  sizeClass: string | null;
  dwtEst: number | null;
  chokepoint: string;
  loiterMin: number;
  destination: string | null;
  destinationFacilityId: number;
  enteredMs: number;
};

type WaitingRow = {
  facilityId: number;
  callId: number;
  mmsi: number;
  name: string | null;
  class: string;
  waitingHours: number;
};

type FleetRow = {
  companyId: number;
  imo: number;
  name: string;
  mmsi: number | null;
  class: string | null;
  lastSeenMs: number | null;
  sogKt: number | null;
};

type CompanyRow = { id: number; symbol: string; name: string };

export interface RefreshLogisticsOptions {
  prices: Prices | null;
  chokepointSlugs: readonly string[];
  now?: Date;
  companyIds?: number[];
  maxCompanies?: number;
  deadline?: number;
}

export interface RefreshLogisticsResult {
  companies: number;
  written: number;
  events: number;
  skipped: number;
}

export async function logisticsTargetCompanyIds(db: Db): Promise<number[]> {
  const rows = await db.execute<{ id: number }>(sql`
    select fc.company_id as id from facility_companies fc
    join facilities f on f.id = fc.facility_id where f.active and f.kind <> 'hq'
    union select company_id from vessel_fleet order by 1`);
  return rows.map((r) => r.id);
}

export async function refreshLogisticsSignals(
  db: Db,
  opts: RefreshLogisticsOptions,
): Promise<RefreshLogisticsResult> {
  const now = opts.now ?? new Date();
  const nowMs = now.getTime();
  const asOf = isoDate(nowMs);
  const result: RefreshLogisticsResult = { companies: 0, written: 0, events: 0, skipped: 0 };
  const all = await logisticsTargetCompanyIds(db);
  const ids = (opts.companyIds ?? all)
    .filter((id) => all.includes(id))
    .slice(0, opts.maxCompanies ?? 80);
  if (!ids.length) return result;
  const links = await db.execute<FacilityLinkRow>(sql`
    select fc.company_id as "companyId", f.id, f.slug, f.name, f.kind::text as kind, fc.role::text as role,
      f.exclusive, fc.commodity_in as "commodityIn", fc.commodity_out as "commodityOut"
    from facility_companies fc join facilities f on f.id = fc.facility_id
    where f.active and f.kind <> 'hq' and fc.company_id in ${ids}`);
  const facilityIds = [...new Set(links.map((l) => l.id))];
  const fids = facilityIds.length ? facilityIds : [-1];
  const since7 = isoDate(nowMs - 6 * DAY_MS);
  const [coverage, calls, inbound, waiting, fleet, companyRows] = await Promise.all([
    db.execute<CoverageRow>(sql`
      select zone,
        coalesce(sum(windows) filter (where day >= ${since7}), 0)::int as windows,
        coalesce(sum(windows_with_data) filter (where day >= ${since7}), 0)::int as "windowsWithData",
        (max(day) filter (where windows_with_data > 0))::text as "lastDataDay",
        (extract(epoch from min(day)::timestamp) * 1000)::float8 as "firstDayMs"
      from altdata_coverage where layer = 'sea' group by zone`),
    db.execute<CallRow>(sql`
      select c.id, c.facility_id as "facilityId", c.mmsi, v.name, v.class::text as class,
        v.size_class as "sizeClass", (extract(epoch from c.entered_at) * 1000)::float8 as "enteredMs",
        (extract(epoch from c.left_at) * 1000)::float8 as "leftMs", c.dwell_min as "dwellMin",
        c.cargo_direction as "cargoDirection"
      from vessel_calls c join vessels v on v.mmsi = c.mmsi
      where c.facility_id in ${fids} and c.entered_at >= ${new Date(nowMs - 70 * DAY_MS)}`),
    db.execute<InboundRow>(sql`
      select distinct on (t.mmsi) t.id as "transitId", t.mmsi, v.name, v.class::text as class,
        v.size_class as "sizeClass", v.dwt_est as "dwtEst", t.chokepoint, t.loiter_min as "loiterMin",
        coalesce(t.destination_at_entry, v.destination_raw) as destination,
        coalesce(v.destination_facility_id, t.destination_facility_id) as "destinationFacilityId",
        (extract(epoch from t.entered_at) * 1000)::float8 as "enteredMs"
      from chokepoint_transits t join vessels v on v.mmsi = t.mmsi
      where t.left_at is null
        and coalesce(v.destination_facility_id, t.destination_facility_id) in ${fids}
        and v.last_seen_at >= ${new Date(nowMs - 2 * DAY_MS)}
      order by t.mmsi, t.entered_at desc`),
    db.execute<WaitingRow>(sql`
      select c.facility_id as "facilityId", c.id as "callId", c.mmsi, v.name, v.class::text as class,
        (extract(epoch from (${now}::timestamptz - c.entered_at)) / 3600)::float8 as "waitingHours"
      from vessel_calls c join vessels v on v.mmsi = c.mmsi
      join lateral (
        select p.sog_kt, p.nav_status from vessel_positions p
        where p.mmsi = c.mmsi order by p.ts desc limit 1
      ) p on true
      where c.facility_id in ${fids} and c.left_at is null
        and c.entered_at < ${new Date(nowMs - DAY_MS)}
        and v.last_seen_at >= ${new Date(nowMs - 12 * 3_600_000)}
        and (p.nav_status in (1, 5) or coalesce(p.sog_kt, 0) < 0.5)`),
    db.execute<FleetRow>(sql`
      select vf.company_id as "companyId", vf.imo, vf.name, v.mmsi, v.class::text as class,
        (extract(epoch from v.last_seen_at) * 1000)::float8 as "lastSeenMs",
        (select p.sog_kt from vessel_positions p where p.mmsi = v.mmsi order by p.ts desc limit 1) as "sogKt"
      from vessel_fleet vf left join vessels v on v.imo = vf.imo
      where vf.company_id in ${ids}`),
    db.execute<CompanyRow>(sql`
      select id, nse_symbol as symbol, name from companies where id in ${ids}`),
  ]);
  const coverageByZone = new Map(coverage.map((c) => [c.zone, c]));
  const companyById = new Map(companyRows.map((c) => [c.id, c]));
  const chokepointZones = opts.chokepointSlugs.map((s) => `chokepoint:${s}`);
  const events: AltdataEventInput[] = [];
  for (const companyId of ids) {
    if (opts.deadline && Date.now() > opts.deadline - 5_000) {
      result.skipped += ids.length - result.companies;
      break;
    }
    const company = companyById.get(companyId);
    if (!company) continue;
    const facilities: LogisticsFacility[] = links
      .filter((l) => l.companyId === companyId)
      .map((l) => ({
        id: l.id,
        slug: l.slug,
        name: l.name,
        kind: l.kind,
        role: l.role,
        exclusive: l.exclusive,
        commodityIn: l.commodityIn,
        commodityOut: l.commodityOut,
      }));
    const own = new Set(facilities.map((f) => f.id));
    const fleetRows = fleet.filter((f) => f.companyId === companyId);
    const computed = computeLogisticsSignals({
      companyId,
      label: company.symbol,
      asOf,
      nowMs,
      facilities,
      coverage: coverageByZone,
      chokepointZones,
      calls: calls.filter((c) => own.has(c.facilityId)),
      inbound: inbound.filter((v) => own.has(v.destinationFacilityId)),
      waiting: waiting.filter((w) => own.has(w.facilityId)),
      fleet: fleetRows.length ? fleetRows : null,
      prices: opts.prices,
    });
    result.written += await writeAltdataSignals(
      db,
      companyId,
      asOf,
      LOGISTICS_SIGNAL_KINDS,
      computed.signals,
      LOGISTICS_MODEL_VERSION,
    );
    events.push(...computed.events);
    result.companies++;
  }
  result.events = await emitAltdataEvents(db, events);
  return result;
}
