import { describe, expect, it } from "vitest";
import { DAY_MS, READ_MAX } from "./common.js";
import {
  cargoValueEstimate,
  computeLogisticsSignals,
  coverageFactor,
  type LogisticsCall,
  type LogisticsInput,
  linkageConfidence,
} from "./logistics.js";

const NOW = Date.parse("2026-10-08T06:00:00Z");
const PRICES = { brent: 80, usdinr: 84 };
const SIKKA = {
  id: 2,
  slug: "ril-sikka-spm",
  name: "Reliance Sikka SPM",
  kind: "spm",
  role: "owner",
  exclusive: true,
  commodityIn: ["crude"],
  commodityOut: ["products"],
};

function coverage(windows: number, withData: number, historyDays: number) {
  return {
    zone: "facility:2",
    windows,
    windowsWithData: withData,
    lastDataDay: "2026-10-08",
    firstDayMs: NOW - historyDays * DAY_MS,
  };
}

let nextId = 1;
function call(daysAgo: number, cls = "tanker"): LogisticsCall {
  const entered = NOW - daysAgo * DAY_MS;
  return {
    id: nextId++,
    facilityId: 2,
    mmsi: 419_000_000 + nextId,
    name: `VESSEL ${nextId}`,
    class: cls,
    sizeClass: "VLCC",
    enteredMs: entered,
    leftMs: entered + 0.5 * DAY_MS,
    dwellMin: 720,
    cargoDirection: "import",
  };
}

function input(over: Partial<LogisticsInput>): LogisticsInput {
  return {
    companyId: 38,
    label: "Reliance",
    asOf: "2026-10-08",
    nowMs: NOW,
    facilities: [SIKKA],
    coverage: new Map(),
    chokepointZones: ["chokepoint:hormuz"],
    calls: [],
    inbound: [],
    waiting: [],
    fleet: null,
    prices: PRICES,
    ...over,
  };
}

describe("cargo value", () => {
  it("values a laden VLCC of crude at Brent and USDINR", () => {
    const v = cargoValueEstimate({ class: "tanker", sizeClass: "VLCC" }, PRICES);
    expect(v.commodity).toBe("crude");
    expect(v.cargoBbl).toBe(1_900_000);
    expect(v.estValueUsd).toBe(152_000_000);
    expect(v.estValueCr).toBe(1276.8);
    expect(v.basis).toBe("dwt_est × 0.95 fill × Brent × USDINR");
  });

  it("applies the product crack and falls back to qualitative without prices", () => {
    const mr = cargoValueEstimate({ class: "tanker", sizeClass: "MR" }, PRICES);
    expect(mr.commodity).toBe("refined products");
    expect(mr.estValueUsd).toBe(Math.round(285_000 * 80 * 1.15));
    const noPrice = cargoValueEstimate({ class: "tanker", sizeClass: "VLCC" }, null);
    expect(noPrice).toMatchObject({ estValueCr: null, basis: "qualitative", cargoBbl: 1_900_000 });
    expect(cargoValueEstimate({ class: "cargo", sizeClass: "Capesize" }, PRICES)).toMatchObject({
      commodity: "dry bulk",
      cargoBbl: null,
      estValueCr: null,
    });
  });

  it("scores coverage and facility linkage", () => {
    expect(coverageFactor(0, 0)).toBe(0);
    expect(coverageFactor(48, 12)).toBe(0.25);
    expect(linkageConfidence({ exclusive: true, role: "owner" })).toBe(0.9);
    expect(linkageConfidence({ exclusive: false, role: "user" })).toBe(0.5);
  });
});

describe("computeLogisticsSignals", () => {
  const kinds = (over: Partial<LogisticsInput>) =>
    computeLogisticsSignals(input(over))
      .signals.map((s) => s.kind)
      .sort();

  it("writes only coverage when no facility or chokepoint is covered", () => {
    const calls = [call(1), call(2)];
    expect(kinds({ calls, coverage: new Map([["facility:2", coverage(48, 2, 70)]]) })).toEqual([
      "logistics_coverage",
    ]);
  });

  it("writes arrivals for covered facilities and needs four weeks for throughput", () => {
    const history = [9, 16, 23, 30, 37, 44, 51, 58].map((d) => call(d));
    const calls = [...history, call(1)];
    const short = kinds({ calls, coverage: new Map([["facility:2", coverage(48, 30, 20)]]) });
    expect(short).toContain("logistics_arrivals_7d");
    expect(short).not.toContain("logistics_throughput_proxy");
    const long = computeLogisticsSignals(
      input({ calls, coverage: new Map([["facility:2", coverage(48, 30, 70)]]) }),
    );
    const arrivals = long.signals.find((s) => s.kind === "logistics_arrivals_7d");
    expect(arrivals?.value).toBe(1);
    const tp = long.signals.find((s) => s.kind === "logistics_throughput_proxy");
    expect(tp?.value).toBe(1);
    for (const s of long.signals) {
      expect((s.inputs.read as string).length).toBeLessThanOrEqual(READ_MAX);
    }
  });

  it("values idle inbound tankers at a chokepoint and raises an event", () => {
    const result = computeLogisticsSignals(
      input({
        inbound: [
          {
            mmsi: 538_000_001,
            name: "OCEAN STAR",
            class: "tanker",
            sizeClass: "VLCC",
            dwtEst: 300_000,
            chokepoint: "hormuz",
            loiterMin: 480,
            destination: "SIKKA",
            destinationFacilityId: 2,
            enteredMs: NOW - DAY_MS,
            transitId: 9,
          },
        ],
      }),
    );
    const exposure = result.signals.find((s) => s.kind === "logistics_chokepoint_exposure");
    expect(exposure?.value).toBe(1);
    expect(exposure?.inputs.totalEstValueCr).toBe(1276.8);
    expect(exposure?.inputs.valueRange).toEqual({ low: 957.6, high: 1596 });
    expect(result.events.map((e) => e.kind)).toEqual(["sea.chokepoint_exposure"]);
  });

  it("reports fleet activity for shipping companies", () => {
    const result = computeLogisticsSignals(
      input({
        facilities: [],
        fleet: [
          {
            imo: 9_232_905,
            name: "DESH BHAKT",
            mmsi: 419_000_001,
            class: "tanker",
            lastSeenMs: NOW - DAY_MS,
            sogKt: 12,
          },
          {
            imo: 9_467_732,
            name: "SWARNA KAMAL",
            mmsi: null,
            class: null,
            lastSeenMs: null,
            sogKt: null,
          },
        ],
      }),
    );
    const fleet = result.signals.find((s) => s.kind === "logistics_fleet_activity");
    expect(fleet?.inputs.fleetSize).toBe(2);
    expect(fleet?.inputs.seen7d).toBe(1);
  });
});
