import { describe, expect, it } from "vitest";
import { toYahooSymbol } from "./yahoo.js";

describe("toYahooSymbol", () => {
  it("keeps ampersands raw so the request layer encodes them once", () => {
    expect(toYahooSymbol("M&M")).toBe("M&M.NS");
    expect(encodeURIComponent(toYahooSymbol("M&M"))).toBe("M%26M.NS");
  });
});
