import { describe, expect, it } from "vitest";
import {
  COOLDOWN_MS,
  hasNewBrokerCall,
  hasNewMaterialAnnouncement,
  type InsightRow,
  shouldRegenerate,
} from "./context.js";

const NOW = Date.parse("2026-10-08T12:00:00Z");
const row = (ageMs: number, over: Partial<InsightRow> = {}): InsightRow =>
  ({
    inputHash: "h1",
    modelVersion: 2,
    generatedAt: new Date(NOW - ageMs),
    ...over,
  }) as InsightRow;
const policy = { force: false, material: false, now: NOW };

describe("shouldRegenerate", () => {
  it("generates when there is no current row", () => {
    expect(shouldRegenerate(null, "h1", 2, policy)).toBe(true);
  });

  it("skips unchanged inputs regardless of age", () => {
    expect(shouldRegenerate(row(3 * COOLDOWN_MS), "h1", 2, policy)).toBe(false);
  });

  it("regenerates unchanged inputs when the model version or force changes", () => {
    expect(shouldRegenerate(row(0), "h1", 3, policy)).toBe(true);
    expect(shouldRegenerate(row(0), "h1", 2, { ...policy, force: true })).toBe(true);
  });

  it("holds changed inputs until the cooldown has passed", () => {
    expect(shouldRegenerate(row(COOLDOWN_MS - 1), "h2", 2, policy)).toBe(false);
    expect(shouldRegenerate(row(COOLDOWN_MS), "h2", 2, policy)).toBe(true);
  });

  it("bypasses the cooldown for material changes and honours a custom cooldown", () => {
    expect(shouldRegenerate(row(60_000), "h2", 2, { ...policy, material: true })).toBe(true);
    expect(
      shouldRegenerate(row(2 * 3_600_000), "h2", 2, { ...policy, cooldownMs: 3_600_000 }),
    ).toBe(true);
  });
});

describe("material change detection", () => {
  const previous = {
    brokers: [{ evidenceId: "brk:1" }],
    announcements: [
      { evidenceId: "ann:1", materiality: "high" },
      { evidenceId: "ann:2", materiality: "low" },
    ],
  };

  it("flags a broker call that was not in the previous inputs", () => {
    expect(hasNewBrokerCall(previous, [{ evidenceId: "brk:1" }])).toBe(false);
    expect(hasNewBrokerCall(previous, [{ evidenceId: "brk:2" }, { evidenceId: "brk:1" }])).toBe(
      true,
    );
    expect(hasNewBrokerCall(null, [{ evidenceId: "brk:1" }])).toBe(true);
  });

  it("flags new or newly high-materiality announcements only", () => {
    expect(
      hasNewMaterialAnnouncement(previous, [
        { evidenceId: "ann:1", materiality: "high" },
        { evidenceId: "ann:3", materiality: "medium" },
      ]),
    ).toBe(false);
    expect(
      hasNewMaterialAnnouncement(previous, [{ evidenceId: "ann:2", materiality: "high" }]),
    ).toBe(true);
  });
});
