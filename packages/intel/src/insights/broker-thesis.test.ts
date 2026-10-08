import { describe, expect, it } from "vitest";
import { groundThesis } from "./broker-thesis.js";
import type { BrokerThesis } from "./schemas.js";
import { NO_EVIDENCE, validateClaims } from "./validate.js";

const input = {
  call: { broker: "Alpha", target: 2_300, priorTarget: 2_000 },
  reportText: "We value the stock at 25x Sep-28 EPS of ₹92. Revenue CAGR of 18% over FY26-28.",
};

const thesis = (overrides: Partial<BrokerThesis> = {}): BrokerThesis => ({
  stance: "bullish",
  keyPoints: ["Revenue compounds at 18%.", "Margins expand to 24%."],
  targetBasis: "25x EPS of ₹92. Implies 40% upside.",
  risks: ["Order delays."],
  estimatesChanged: null,
  ...overrides,
});

const check = (t: BrokerThesis) => validateClaims(t, input, { known: NO_EVIDENCE });

describe("groundThesis", () => {
  it("drops fabricated key points and sentences", () => {
    const t = thesis();
    const out = groundThesis(t, check(t), input);
    expect(out?.keyPoints).toEqual(["Revenue compounds at 18%."]);
    expect(out?.targetBasis).toBe("25x EPS of ₹92.");
  });

  it("nulls a scrubbed field and rejects when no key point survives", () => {
    const t = thesis({ keyPoints: ["Margins expand to 24%."], targetBasis: "Implies 40% upside." });
    expect(groundThesis(t, check(t), input)).toBeNull();
    const kept = thesis({ targetBasis: "Implies 40% upside." });
    expect(groundThesis(kept, check(kept), input)?.targetBasis).toBeNull();
  });

  it("keeps a fully grounded thesis untouched", () => {
    const t = thesis({ keyPoints: ["Target ₹2,300 from ₹2,000."], targetBasis: null });
    expect(check(t)).toEqual([]);
    expect(groundThesis(t, [], input)).toBe(t);
  });
});
