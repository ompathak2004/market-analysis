import { randomUUID } from "node:crypto";
import { createLogger, MemoryObjectStore, sha256 } from "@ma/core";
import { closeDb, createDb, type Db, documentRevisions, documents, eq } from "@ma/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DocumentStore, joinPages, pageOf, TEXT_PARSER_VERSION } from "./documents.js";
import type { Firecrawl } from "./firecrawl.js";
import type { HttpClient } from "./http.js";

const url = process.env.DATABASE_URL_TEST;

function httpReturning(bodies: Map<string, string>): HttpClient {
  return {
    get: async (target: string) => {
      const text = bodies.get(target) ?? "";
      return {
        status: 200,
        notModified: false,
        headers: new Headers({ "content-type": "text/html" }),
        body: new TextEncoder().encode(text),
        text: () => text,
      };
    },
  } as unknown as HttpClient;
}

describe("joinPages", () => {
  it("builds a page map over UTF-16 offsets", () => {
    const { text, pageMap } = joinPages(["first page", "second"]);
    expect(text).toBe("first page\n\nsecond");
    expect(pageMap).toEqual([
      { page: 1, start: 0, end: 10 },
      { page: 2, start: 12, end: 18 },
    ]);
    expect(pageOf(pageMap, 13)).toBe(2);
    expect(pageOf(pageMap, 11)).toBeNull();
  });
});

describe.skipIf(!url)("DocumentStore revisions (DATABASE_URL_TEST)", () => {
  let db: Db;
  const target = `https://example.test/${randomUUID()}`;
  const bodies = new Map<string, string>();
  const objects = new MemoryObjectStore();
  let store: DocumentStore;

  beforeAll(() => {
    db = createDb(url as string, 1);
    store = new DocumentStore(
      db,
      httpReturning(bodies),
      {} as Firecrawl,
      createLogger("test", "error"),
      objects,
    );
  });

  afterAll(async () => {
    await db.delete(documents).where(eq(documents.url, target));
    await closeDb(db);
  });

  it("writes a revision per distinct body and hydrates text from the object store", async () => {
    bodies.set(target, "alpha body");
    const first = await store.fetch(target, { source: "test" });
    expect(first.changed).toBe(true);
    expect(first.revision.contentSha256).toBe(sha256("alpha body"));
    expect(first.revision.textParserVersion).toBe(TEXT_PARSER_VERSION);
    expect(first.revision.textS3Key).toMatch(/^text\//);
    expect(first.doc.currentRevisionId).toBe(first.revision.id);
    expect(objects.objects.has(first.revision.textS3Key as string)).toBe(true);

    const same = await store.fetch(target, { source: "test" });
    expect(same.changed).toBe(false);
    expect(same.revision.id).toBe(first.revision.id);

    bodies.set(target, "beta body");
    const second = await store.fetch(target, { source: "test" });
    expect(second.changed).toBe(true);
    expect(second.revision.id).not.toBe(first.revision.id);
    const rows = await db.query.documentRevisions.findMany({
      where: eq(documentRevisions.documentId, first.doc.id),
    });
    expect(rows).toHaveLength(2);

    await db.update(documents).set({ content: null }).where(eq(documents.id, first.doc.id));
    const fresh = new DocumentStore(
      db,
      httpReturning(bodies),
      {} as Firecrawl,
      createLogger("test", "error"),
      objects,
    );
    expect(await fresh.text(second.revision)).toBe("beta body");
    expect(await fresh.text(first.revision)).toBe("alpha body");
    expect(await fresh.textOf(first.doc.id)).toBe("beta body");
  });

  it("snapshots a legacy inline body as its first revision", async () => {
    const legacyUrl = `${target}/legacy`;
    const [doc] = await db
      .insert(documents)
      .values({
        url: legacyUrl,
        source: "test",
        sha256: sha256("legacy body"),
        byteSize: 11,
        content: "legacy body",
      })
      .returning();
    if (!doc) throw new Error("insert failed");
    try {
      const snap = await store.snapshot(doc);
      expect(snap?.created).toBe(true);
      expect(snap?.revision.rawUnavailable).toBe(true);
      const again = await store.snapshot({ ...doc, currentRevisionId: snap?.revision.id ?? null });
      expect(again?.created).toBe(false);
      const cached = await store.fetch(legacyUrl, { source: "test", maxAgeMs: 60_000 });
      expect(cached.fromCache).toBe(true);
      expect(cached.text).toBe("legacy body");
    } finally {
      await db.delete(documents).where(eq(documents.id, doc.id));
    }
  });
});
