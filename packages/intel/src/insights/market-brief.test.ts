import { describe, expect, it } from "vitest";
import type { MarketInputs } from "./inputs.js";
import { finalizeMarketBrief, groundMarketBrief } from "./market-brief.js";
import type { MarketBrief } from "./schemas.js";

const inputs: MarketInputs = {
  asOf: "2026-10-07",
  indices: [{ code: "NIFTY", name: "Nifty 50", last: 25_310.4, chg1dPct: -0.8, chg1wPct: 1.2 }],
  breadth: {
    universe: "nifty500",
    sample: 480,
    advancers: 140,
    decliners: 330,
    unchanged: 10,
    above50dmaPct: 41.5,
    above200dmaPct: 62,
  },
  sectors: [{ sector: "IT", companies: 20, median1dPct: -1.9, median1wPct: 0.4 }],
  movers: { gainers: [], losers: [] },
  brokerCalls: [],
  signalMovers: [],
  announcements: [],
  evidence: [
    { id: "idx:NIFTY", kind: "source", label: "Nifty 50 closes", url: null },
    { id: "brd", kind: "source", label: "Breadth", url: null },
    { id: "sec", kind: "source", label: "Sectors", url: null },
  ],
};

const brief = (overrides: Partial<MarketBrief> = {}): MarketBrief => ({
  headline: "Nifty slips 0.8% as IT leads declines.",
  bullets: [
    { text: "Nifty 50 fell 0.8% to 25,310.", evidence: ["idx:NIFTY"] },
    { text: "Decliners outnumbered advancers 330 to 140.", evidence: ["brd"] },
    { text: "IT median fell 1.9%.", evidence: ["sec"] },
  ],
  sectorRotation: "IT was weakest.",
  breadth: "Only 41.5% of stocks are above the 50-DMA.",
  notableCalls: [],
  riskFlags: [],
  evidence: ["idx:NIFTY", "brd"],
  ...overrides,
});

describe("market brief grounding", () => {
  it("accepts a cited, grounded brief", () => {
    const { violations } = finalizeMarketBrief(brief(), inputs);
    expect(violations).toEqual([]);
  });

  it("drops uncited bullets and rejects when fewer than three remain", () => {
    const raw = brief({
      bullets: [
        ...brief().bullets.slice(0, 2),
        { text: "Banks rallied 3.4%.", evidence: ["bank:1"] },
      ],
    });
    const { brief: b, violations } = finalizeMarketBrief(raw, inputs);
    expect(violations.map((v) => [v.path, v.reason])).toEqual([[["bullets", 2], "uncited"]]);
    expect(groundMarketBrief(b, violations, inputs)).toBeNull();
  });

  it("re-checks after dropping and rejects anything still ungrounded", () => {
    const raw = brief({
      bullets: [...brief().bullets, { text: "Midcaps fell 7.7%.", evidence: ["sec"] }],
      breadth: "Breadth was the worst in 13 sessions at 18%.",
    });
    const { brief: b, violations } = finalizeMarketBrief(raw, inputs);
    expect(groundMarketBrief(b, violations.slice(0, 1), inputs)).toBeNull();
    expect(groundMarketBrief(b, violations, inputs)?.bullets).toHaveLength(3);
  });
});
