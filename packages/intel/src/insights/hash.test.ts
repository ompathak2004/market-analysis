import { describe, expect, it } from "vitest";
import { companyFixture } from "./fixtures.js";
import { brokersHash, canonicalJson, inputHash } from "./hash.js";

describe("canonicalJson", () => {
  it("sorts keys and drops undefined and volatile keys", () => {
    expect(canonicalJson({ b: 1, a: { d: undefined, c: 2, asOf: "x" } })).toBe(
      '{"a":{"c":2},"b":1}',
    );
  });

  it("rounds pct keys to one decimal", () => {
    expect(canonicalJson({ upsidePct: 12.345, value: 12.345 })).toBe(
      '{"upsidePct":12.3,"value":12.345}',
    );
  });
});

describe("inputHash", () => {
  const base = companyFixture();
  const h = inputHash(base);

  it("is stable across asOf, evidence, rule insights and volatile price fields", () => {
    const price = base.price;
    if (!price) throw new Error("fixture");
    expect(
      inputHash({
        ...base,
        asOf: "2026-10-09",
        evidence: [],
        ruleInsights: [
          { id: "x", group: "price", tone: "neutral", text: "t", value: null, evidence: [] },
        ],
        price: { ...price, last: 1_761, chg1dPct: 1.2, chg1mPct: 3.24 },
      }),
    ).toBe(h);
  });

  it("ignores the previous brief so a fresh brief does not invalidate itself", () => {
    const prev = {
      generatedAt: "2026-10-07T00:00:00Z",
      verdict: { score: 60, label: "constructive" as const, confidence: 0.6 },
      thesis: ["a"],
    };
    expect(inputHash({ ...base, previousBrief: prev })).toBe(h);
  });

  it("changes when material inputs change", () => {
    const price = base.price;
    if (!price) throw new Error("fixture");
    expect(inputHash({ ...base, price: { ...price, chg1mPct: 3.4 } })).not.toBe(h);
    expect(inputHash({ ...base, brokers: [] })).not.toBe(h);
  });
});

describe("brokersHash", () => {
  it("ignores non-broker inputs", () => {
    const base = companyFixture();
    expect(brokersHash({ ...base })).toBe(brokersHash(companyFixture({ price: null })));
    expect(brokersHash({ ...base, brokers: [] })).not.toBe(brokersHash(base));
  });
});
