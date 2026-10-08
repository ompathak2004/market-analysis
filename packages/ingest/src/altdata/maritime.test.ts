import { describe, expect, it } from "vitest";
import {
  cargoDirection,
  deriveCalls,
  deriveTransits,
  flagForMmsi,
  isValidImo,
  matchDestination,
  normalizeDestination,
  sizeClassFor,
  type VesselPoint,
  vesselClass,
} from "./maritime.js";

const MIN = 60_000;
const T0 = Date.parse("2026-10-01T00:00:00Z");
const SIKKA = { id: 2, locode: "INSIK", aliases: ["SIKKA", "IN SIK", "SIKKA FOR ORDERS"] };
const MUNDRA = { id: 5, locode: "INMUN", aliases: ["MUNDRA"] };
const FACILITIES = [SIKKA, MUNDRA];

function point(minute: number, lat: number, lon: number, sogKt: number | null = 0.2): VesselPoint {
  return { ts: new Date(T0 + minute * MIN), lat, lon, sogKt, navStatus: null };
}

describe("destination matching", () => {
  it("normalizes free-text AIS destinations", () => {
    expect(normalizeDestination("  sikka  for-orders ")).toBe("SIKKA FOR ORDERS");
    expect(normalizeDestination("@@@")).toBeNull();
  });

  it("matches LOCODEs, spaced LOCODEs, aliases and the final leg of a route", () => {
    expect(matchDestination("SIKKA FOR ORDERS", FACILITIES)).toBe(2);
    expect(matchDestination("IN SIK", FACILITIES)).toBe(2);
    expect(matchDestination("INMUN", FACILITIES)).toBe(5);
    expect(matchDestination("SGSIN>INMUN", FACILITIES)).toBe(5);
    expect(matchDestination("SGSIN>PEBGA", FACILITIES)).toBeNull();
    expect(matchDestination(null, FACILITIES)).toBeNull();
  });
});

describe("vessel identity helpers", () => {
  it("classifies by AIS ship type and size", () => {
    expect(vesselClass(80, "DESH VAIBHAV", null)).toBe("tanker");
    expect(vesselClass(84, "SAKURA LNG", null)).toBe("gas");
    expect(vesselClass(71, "MSC ANNA", null)).toBe("container");
    expect(sizeClassFor("tanker", 333)).toEqual({
      sizeClass: "VLCC",
      dwtEst: 300_000,
      bbl: 2_000_000,
    });
    expect(sizeClassFor("tanker", 183).sizeClass).toBe("MR");
    expect(sizeClassFor("cargo", 292).sizeClass).toBe("Capesize");
    expect(sizeClassFor("tanker", null).sizeClass).toBeNull();
  });

  it("derives flags from the MMSI MID and validates IMO check digits", () => {
    expect(flagForMmsi(419_000_123)).toBe("IN");
    expect(flagForMmsi(538_001_234)).toBe("MH");
    expect(flagForMmsi(12_345)).toBeNull();
    expect(isValidImo(9_232_905)).toBe(true);
    expect(isValidImo(9_232_906)).toBe(false);
  });

  it("reads cargo direction from draught changes", () => {
    expect(cargoDirection(20.5, 11.2)).toBe("import");
    expect(cargoDirection(9, 14)).toBe("export");
    expect(cargoDirection(12, 12.3)).toBe("unknown");
    expect(cargoDirection(null, 12)).toBe("unknown");
  });
});

describe("deriveCalls", () => {
  const zone = { id: 2, lat: 22.45, lon: 69.75, radiusKm: 10 };

  it("closes a call after consecutive outside positions", () => {
    const calls = deriveCalls(
      [
        point(0, 22.6, 69.9),
        point(10, 22.45, 69.75),
        point(70, 22.46, 69.76),
        point(80, 23, 70.5),
        point(90, 23.2, 70.8),
      ],
      [zone],
      { now: new Date(T0 + 200 * MIN) },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.endedBy).toBe("exit");
    expect(calls[0]?.enteredAt.getTime()).toBe(T0 + 10 * MIN);
    expect(calls[0]?.leftAt?.getTime()).toBe(T0 + 70 * MIN);
    expect(calls[0]?.positions).toBe(2);
  });

  it("times out stale calls and keeps fresh ones open", () => {
    const stale = deriveCalls([point(0, 22.45, 69.75)], [zone], {
      now: new Date(T0 + 7 * 60 * MIN),
    });
    expect(stale[0]?.endedBy).toBe("timeout");
    expect(stale[0]?.leftAt?.getTime()).toBe(T0);
    const fresh = deriveCalls([point(0, 22.45, 69.75)], [zone], { now: new Date(T0 + 60 * MIN) });
    expect(fresh[0]?.endedBy).toBeNull();
    expect(fresh[0]?.leftAt).toBeNull();
  });
});

describe("deriveTransits", () => {
  const box = [
    [0, 100],
    [2, 105],
  ] as const;

  it("accumulates loiter minutes only between slow consecutive positions", () => {
    const transits = deriveTransits(
      [
        point(0, 1, 100.5, 12),
        point(60, 1, 101, 0.3),
        point(120, 1, 101, 0.4),
        point(600, 1, 101.01, 0.2),
        point(660, 1, 104.5, 11),
      ],
      [{ slug: "singapore_strait", box }],
      { now: new Date(T0 + 700 * MIN) },
    );
    expect(transits).toHaveLength(1);
    const t = transits[0];
    expect(t?.chokepoint).toBe("singapore_strait");
    expect(t?.loiterMin).toBe(60 + 120);
    expect(t?.minSogKt).toBe(0.2);
    expect(t?.direction).toBe("eastbound");
    expect(t?.leftAt).toBeNull();
    expect(t?.positions).toBe(5);
  });
});
