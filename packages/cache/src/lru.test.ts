import { describe, expect, it } from "vitest";
import { Lru } from "./lru.js";

describe("Lru", () => {
  it("evicts least recently used", () => {
    const lru = new Lru<number>(2);
    lru.set("a", 1);
    lru.set("b", 2);
    lru.get("a");
    lru.set("c", 3);
    expect(lru.get("b")).toBeUndefined();
    expect(lru.get("a")).toBe(1);
    expect(lru.get("c")).toBe(3);
  });

  it("deletes by prefix", () => {
    const lru = new Lru<number>(10);
    lru.set("q:1", 1);
    lru.set("q:2", 2);
    lru.set("r:1", 3);
    lru.deletePrefix("q:");
    expect(lru.size).toBe(1);
  });
});
