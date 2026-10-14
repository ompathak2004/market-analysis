import { describe, expect, it } from "vitest";
import { uniqueBy } from "./util.js";

describe("uniqueBy", () => {
  it("keeps the first item for each key and preserves order", () => {
    const rows = [
      { k: "a", v: 1 },
      { k: "b", v: 2 },
      { k: "a", v: 3 },
    ];
    expect(uniqueBy(rows, (r) => r.k)).toEqual([
      { k: "a", v: 1 },
      { k: "b", v: 2 },
    ]);
  });
});
