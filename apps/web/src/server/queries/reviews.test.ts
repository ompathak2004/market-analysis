import { describe, expect, it } from "vitest";
import {
  clampLimit,
  decodeCursor,
  encodeCursor,
  REVIEW_CONFIDENCE_THRESHOLD,
  REVIEW_PAGE_DEFAULT,
  REVIEW_PAGE_MAX,
  reviewQueueQuery,
} from "./reviews";

function render(query: { queryChunks: unknown[] }) {
  const params: unknown[] = [];
  const walk = (chunks: unknown[]): string =>
    chunks
      .map((c) => {
        if (c && typeof c === "object" && "queryChunks" in c)
          return walk((c as { queryChunks: unknown[] }).queryChunks);
        if (c && typeof c === "object" && "value" in c && Array.isArray(c.value))
          return c.value.join("");
        params.push(c);
        return `$${params.length}`;
      })
      .join("");
  return { sql: walk(query.queryChunks).replace(/\s+/g, " "), params };
}

describe("review queue cursor", () => {
  it("round-trips created_at and id", () => {
    const c = { createdAt: "2026-10-14T09:00:00.123456Z", id: 42 };
    const raw = encodeCursor(c);
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(raw)).toEqual(c);
  });

  it("rejects malformed cursors", () => {
    const b64 = (s: string) => Buffer.from(s).toString("base64url");
    for (const bad of [
      null,
      undefined,
      "",
      "not base64!",
      b64("2026-10-14T09:00:00Z"),
      b64("2026-10-14T09:00:00Z|0"),
      b64("2026-10-14T09:00:00Z|-1"),
      b64("2026-10-14 09:00:00|1"),
      b64("2026-13-45T09:00:00Z|1"),
      b64("2026-10-14T09:00:00Z|1; drop table x"),
      b64("2026-10-14T09:00:00Z|99999999999999999"),
      "A".repeat(97),
    ]) {
      expect(decodeCursor(bad)).toBeNull();
    }
  });
});

describe("clampLimit", () => {
  it("bounds the page size", () => {
    expect(clampLimit(undefined)).toBe(REVIEW_PAGE_DEFAULT);
    expect(clampLimit(Number.NaN)).toBe(REVIEW_PAGE_DEFAULT);
    expect(clampLimit(0)).toBe(1);
    expect(clampLimit(7.9)).toBe(7);
    expect(clampLimit(10_000)).toBe(REVIEW_PAGE_MAX);
  });
});

describe("reviewQueueQuery", () => {
  it("selects pending low-confidence or new-counterparty rows oldest first", () => {
    const q = render(reviewQueueQuery({ limit: 25, after: null }));
    const text = q.sql;
    expect(text).toContain("where o.status = 'pending'");
    expect(text).toContain("o.confidence < $1 or o.new_counterparty");
    expect(text).toContain("order by o.created_at, o.id limit $2");
    expect(text).not.toContain("(o.created_at, o.id) >");
    expect(q.params).toEqual([REVIEW_CONFIDENCE_THRESHOLD, 26]);
  });

  it("adds a keyset predicate after a cursor", () => {
    const after = { createdAt: "2026-10-14T09:00:00.5Z", id: 9 };
    const q = render(reviewQueueQuery({ limit: 10, after }));
    const text = q.sql;
    expect(text).toContain("and (o.created_at, o.id) > ($2::timestamptz, $3::bigint)");
    expect(text).toContain("limit $4");
    expect(q.params).toEqual([REVIEW_CONFIDENCE_THRESHOLD, after.createdAt, 9, 11]);
  });
});
