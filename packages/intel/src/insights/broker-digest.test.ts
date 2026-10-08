import { describe, expect, it } from "vitest";
import { digestInputs, digestViolations, finalizeDigest, groundDigest } from "./broker-digest.js";
import { companyFixture } from "./fixtures.js";
import type { BrokerDigest } from "./schemas.js";

const input = digestInputs(companyFixture());

const raw = (overrides: Partial<BrokerDigest> = {}): BrokerDigest => ({
  consensusRead: "22 analysts, 72.7% buy, mean target ₹2,100.",
  byBroker: [
    {
      broker: "Alpha Securities",
      stance: "bullish",
      says: "Raised target to ₹2,300 from ₹2,000.",
      target: 1,
      changed: "Upgrade.",
      evidence: ["brk:404"],
    },
    {
      broker: "Ghost Capital",
      stance: "bearish",
      says: "Sell.",
      target: 900,
      changed: null,
      evidence: [],
    },
  ],
  divergence: { description: "Single broker.", bullCase: null, bearCase: null },
  targetDispersion: { low: 0, high: 0, mean: 0, spreadPct: 0, read: "Wide." },
  revisionMomentum: { direction: "flat", read: "EPS revised up 3.1% in 30 days." },
  evidence: ["cns", "cns", "brk:404"],
  ...overrides,
});

describe("finalizeDigest", () => {
  it("binds each broker view to its own evidence and drops unknown brokers and ids", () => {
    const d = finalizeDigest(raw(), input);
    expect(d.byBroker).toEqual([
      expect.objectContaining({ broker: "Alpha Securities", target: 2_300, evidence: ["brk:11"] }),
    ]);
    expect(d.evidence).toEqual(["cns"]);
    expect(digestViolations(d, input)).toEqual([]);
  });
});

describe("digest grounding", () => {
  it("flags fabricated figures in broker views and uncited narrative", () => {
    const d = finalizeDigest(
      raw({
        byBroker: [
          {
            broker: "Alpha Securities",
            stance: "bullish",
            says: "Sees 35% earnings growth.",
            target: null,
            changed: null,
            evidence: [],
          },
        ],
        evidence: [],
      }),
      input,
    );
    expect(digestViolations(d, input).map((v) => [v.path, v.reason])).toEqual([
      [["consensusRead"], "uncited"],
      [["byBroker", 0, "says"], "ungrounded"],
      [["divergence", "description"], "uncited"],
      [["targetDispersion", "read"], "uncited"],
      [["revisionMomentum", "read"], "uncited"],
    ]);
  });

  it("grounds precomputed figures in the evidence they derive from", () => {
    const d = finalizeDigest(
      raw({
        targetDispersion: {
          low: 0,
          high: 0,
          mean: 0,
          spreadPct: 0,
          read: "Targets span 47.6% around a ₹2,100 mean.",
        },
      }),
      input,
    );
    expect(digestViolations(d, input)).toEqual([]);
    const brokerOnly = finalizeDigest(raw({ evidence: ["brk:11"] }), input);
    expect(digestViolations(brokerOnly, input).map((v) => v.numbers)).toEqual([[22, 72.7], [3.1]]);
  });

  it("rejects the digest when no broker view survives", () => {
    const d = finalizeDigest(
      raw({
        byBroker: [
          {
            broker: "Alpha Securities",
            stance: "bullish",
            says: "Sees 35% earnings growth.",
            target: null,
            changed: null,
            evidence: [],
          },
        ],
      }),
      input,
    );
    expect(groundDigest(d, digestViolations(d, input), input)).toBeNull();
  });

  it("scrubs ungrounded narrative sentences and keeps the rest", () => {
    const d = finalizeDigest(
      raw({ consensusRead: "Mean target ₹2,100. Street sees ₹3,000 by FY28." }),
      input,
    );
    const out = groundDigest(d, digestViolations(d, input), input);
    expect(out?.consensusRead).toBe("Mean target ₹2,100.");
    expect(out?.byBroker).toHaveLength(1);
  });
});
