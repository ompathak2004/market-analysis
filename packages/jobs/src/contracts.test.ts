import { describe, expect, it } from "vitest";
import { contractOf, JOB_TYPES, LANES, parseEnvelope, parsePayload, unitKey } from "./contracts.js";
import { LANE_CONCURRENCY } from "./policies.js";

describe("job contracts", () => {
  it("assigns every job type to a known lane with a positive deadline", () => {
    for (const type of JOB_TYPES) {
      const contract = contractOf(type);
      expect(LANES).toContain(contract.lane);
      expect(contract.deadlineMs).toBeGreaterThan(0);
      expect(contract.retryLimit).toBeGreaterThanOrEqual(0);
    }
    for (const lane of LANES) expect(LANE_CONCURRENCY[lane]).toBeGreaterThan(0);
  });

  it("keys company units by company id and singletons by type", () => {
    expect(unitKey("prices.sync", { companyId: 7 })).toBe("prices.sync:7");
    expect(unitKey("aircraft.sample", {})).toBe("aircraft.sample");
  });

  it("keys price units by symbol, window, generation and parser version", () => {
    const unit = {
      seriesId: 4,
      symbol: "RELIANCE.NS",
      from: "2021-10-12",
      toExclusive: "2022-10-12",
      generation: 1,
      parserVersion: 1,
    };
    expect(unitKey("prices.window", unit)).toBe(
      "prices.window:RELIANCE.NS:2021-10-12:2022-10-12:g1:p1",
    );
    expect(unitKey("prices.window", { ...unit, mode: "repair" })).toBe(
      "prices.window:repair:RELIANCE.NS:2021-10-12:2022-10-12:g1:p1",
    );
    expect(unitKey("index.daily", { seriesId: 9, symbol: "^NSEI", date: "2026-10-13" })).toBe(
      "index.daily:^NSEI:2026-10-13",
    );
    expect(
      unitKey("prices.rebuild", { seriesId: 4, symbol: "TCS.NS", generation: 2, parserVersion: 1 }),
    ).toBe("prices.rebuild:TCS.NS:g2:p1");
    expect(() => parsePayload("prices.window", { ...unit, toExclusive: unit.from })).toThrow();
    expect(() => parsePayload("prices.window", { ...unit, from: "2021/10/12" })).toThrow();
  });

  it("rejects unknown payload fields", () => {
    expect(() => parsePayload("prices.sync", { companyId: 1, extra: true })).toThrow();
    expect(() => parsePayload("prices.sync", { companyId: -1 })).toThrow();
  });

  it("parses envelopes with defaults and rejects unknown types", () => {
    expect(parseEnvelope({ type: "prices.sync", payload: { companyId: 3 } })).toEqual({
      type: "prices.sync",
      payload: { companyId: 3 },
      campaignId: null,
      runId: null,
      attemptBase: 0,
      deferrals: 0,
    });
    expect(() => parseEnvelope({ type: "nope", payload: {} })).toThrow(/unknown job type/);
    expect(() => parseEnvelope({ type: "prices.sync", payload: {} })).toThrow();
  });
});
