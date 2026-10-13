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
