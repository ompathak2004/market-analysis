import { describe, expect, it } from "vitest";
import { DAY_MS, READ_MAX } from "./common.js";
import { computeTravelSignals, type TravelInput, type TravelLeg } from "./travel.js";

const NOW = Date.parse("2026-10-08T06:00:00Z");
const HUBS = [{ icao: "OMDB", city: "Dubai", region: "Gulf", theme: "sovereign funds" }];

let nextId = 1;
function leg(daysAgo: number, arrIcao: string, arrCity: string): TravelLeg {
  const at = NOW - daysAgo * DAY_MS;
  return {
    id: nextId++,
    aircraftId: 1,
    registration: "VT-AKV",
    departedMs: at - 2 * 3_600_000,
    arrivedMs: at,
    depIcao: "VABB",
    depCity: "Mumbai",
    arrIcao,
    arrCity,
    arrCountry: arrIcao.startsWith("V") ? "IN" : "AE",
    completeness: "full",
  };
}

function input(legs: TravelLeg[], historyDays: number): TravelInput {
  return {
    companyId: 7,
    label: "Reliance",
    asOf: "2026-10-08",
    nowMs: NOW,
    historyStartMs: NOW - historyDays * DAY_MS,
    aircraft: [
      {
        id: 1,
        registration: "VT-AKV",
        groupName: "Reliance",
        confidence: 1,
        homeIcao: "VABB",
        lastSeenMs: NOW - DAY_MS,
      },
    ],
    legs,
    dealHubs: HUBS,
    airport: () => null,
    counterparties: [],
    relations: new Map(),
    otherArrivals: [],
    announcements: [],
  };
}

const kinds = (legs: TravelLeg[], days: number) =>
  computeTravelSignals(input(legs, days)).signals.map((s) => s.kind);

describe("computeTravelSignals", () => {
  it("links observed arrivals to operating-site questions without asserting visits", () => {
    const data = input([leg(1, "VOMY", "Mysuru")], 100);
    data.airport = () => ({ lat: 12.2, lon: 76.6 });
    data.ownFacilities = [
      {
        companyId: 7,
        symbol: "TEST",
        name: "Test",
        facilityId: 9,
        facilityName: "Mysuru plant",
        kind: "plant",
        lat: 12.2,
        lon: 76.6,
      },
    ];
    const read = computeTravelSignals(data).signals.find(
      (s) => s.kind === "travel_operating_site_arrivals_30d",
    );
    expect(read?.value).toBe(1);
    expect(read?.inputs.read).toContain("unverified");
    expect(read?.inputs.evidence[0]?.kind).toBe("leg");
    data.legs[0] = { ...(data.legs[0] as TravelLeg), arrivedMs: null };
    expect(
      computeTravelSignals(data).signals.some(
        (s) => s.kind === "travel_operating_site_arrivals_30d",
      ),
    ).toBe(false);
  });
  const baseline = Array.from({ length: 11 }, (_, w) => leg(10 + w * 7, "VIDP", "Delhi"));
  const spike = [1, 2, 3, 4, 5, 6].map((d) => leg(d, "VIDP", "Delhi"));

  it("always writes legs and coverage, and gates anomalies on six weeks of history", () => {
    expect(kinds(spike, 20).sort()).toEqual(["travel_coverage", "travel_legs_7d"]);
    const result = computeTravelSignals(input([...baseline, ...spike], 100));
    const anomaly = result.signals.find((s) => s.kind === "travel_frequency_anomaly");
    expect(anomaly?.value).toBeGreaterThanOrEqual(1.5);
    expect(anomaly?.inputs.history_weeks).toBeGreaterThanOrEqual(6);
  });

  it("skips the anomaly when this week matches the baseline", () => {
    expect(kinds([...baseline, leg(2, "VIDP", "Delhi")], 100)).not.toContain(
      "travel_frequency_anomaly",
    );
  });

  it("flags first visits only after 60 days of history and never for home airports", () => {
    const legs = [...baseline, leg(2, "VOBL", "Bengaluru"), leg(3, "VABB", "Mumbai")];
    expect(kinds(legs, 30)).not.toContain("travel_new_destination");
    const result = computeTravelSignals(input(legs, 100));
    const dest = result.signals.find((s) => s.kind === "travel_new_destination");
    expect(dest?.value).toBe(1);
    expect(result.events.map((e) => e.kind)).toContain("air.new_destination");
  });

  it("needs two deal-hub visits in 30 days at twice the baseline", () => {
    expect(kinds([leg(4, "OMDB", "Dubai")], 100)).not.toContain("travel_deal_hub_cluster");
    const result = computeTravelSignals(
      input([leg(4, "OMDB", "Dubai"), leg(12, "OMDB", "Dubai")], 100),
    );
    const hub = result.signals.find((s) => s.kind === "travel_deal_hub_cluster");
    expect(hub?.value).toBe(2);
    expect(hub?.inputs.baselineMonthly).toBe(0);
    expect(result.events.map((e) => e.kind)).toContain("air.deal_hub_cluster");
    const crowded = [40, 50, 60, 75, 90, 105].map((d) => leg(d, "OMDB", "Dubai"));
    expect(
      kinds([...crowded, leg(4, "OMDB", "Dubai"), leg(12, "OMDB", "Dubai")], 150),
    ).not.toContain("travel_deal_hub_cluster");
  });

  it("keeps every read within the template length", () => {
    const result = computeTravelSignals(
      input([...baseline, ...spike, leg(4, "OMDB", "Dubai")], 200),
    );
    for (const s of result.signals) {
      expect(typeof s.inputs.read).toBe("string");
      expect((s.inputs.read as string).length).toBeLessThanOrEqual(READ_MAX);
    }
  });
});
