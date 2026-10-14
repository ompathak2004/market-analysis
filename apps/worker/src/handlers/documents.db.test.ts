import { randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { MemoryObjectStore, sha256 } from "@ma/core";
import { closeDb, createDb, type Db, sql, type Tx } from "@ma/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WorkerContext } from "../context.js";
import { documentHandlers } from "./documents.js";

const url = process.env.DATABASE_URL_TEST;

class Rollback extends Error {}

describe.skipIf(!url)("documents.release (DATABASE_URL_TEST)", () => {
  let db: Db;
  const tag = `docs-${randomUUID().slice(0, 8)}`;

  beforeAll(() => {
    db = createDb(url ?? "", 2);
  });

  afterAll(async () => {
    await closeDb(db);
  });

  async function rolledBack(fn: (tx: Tx) => Promise<void>): Promise<void> {
    await db
      .transaction(async (tx) => {
        await fn(tx);
        throw new Rollback();
      })
      .catch((err: unknown) => {
        if (!(err instanceof Rollback)) throw err;
      });
  }

  async function stored(tx: Tx, text: string, objectBody: Uint8Array | null): Promise<number> {
    const hash = sha256(text);
    const key = `text/${hash.slice(0, 2)}/${hash}.txt.gz`;
    const docs = await tx.execute<{ id: number }>(sql`
      insert into documents (url, source, sha256, byte_size, content, status)
      values (${`https://example.test/${tag}/${hash}`}, 'screener', ${hash}, ${text.length}, ${text}, 'parsed')
      returning id`);
    const id = Number(docs[0]?.id);
    const revs = await tx.execute<{ id: number }>(sql`
      insert into document_revisions (document_id, content_sha256, text_bytes, text_s3_key)
      values (${id}, ${hash}, ${text.length}, ${key}) returning id`);
    await tx.execute(sql`
      insert into storage_objects (key, sha256, bytes, kind) values (${key}, ${hash}, ${text.length}, 'text')`);
    await tx.execute(
      sql`update documents set current_revision_id = ${revs[0]?.id} where id = ${id}`,
    );
    if (objectBody) objects.objects.set(key, { body: objectBody, sha256: sha256(objectBody) });
    return id;
  }

  const objects = new MemoryObjectStore();

  it("releases only bodies whose object decompresses to the recorded hash", async () => {
    await rolledBack(async (tx) => {
      const good = await stored(tx, `${tag} intact`, gzipSync(`${tag} intact`));
      const missing = await stored(tx, `${tag} missing`, null);
      const corrupt = await stored(tx, `${tag} corrupt`, gzipSync(`${tag} other`));
      const garbage = await stored(tx, `${tag} garbage`, new Uint8Array([1, 2, 3]));
      const ctx = { db: tx, objects } as unknown as WorkerContext;
      const result = await documentHandlers["documents.release"]({
        ctx,
        type: "documents.release",
        payload: {},
        attempt: 1,
        campaignId: null,
        deadline: Date.now() + 60_000,
        signal: new AbortController().signal,
        fence: undefined,
        expired: () => false,
      } as never);
      const rows = await tx.execute<{ id: number; released: boolean }>(sql`
        select id, content is null as released from documents
        where id in (${good}, ${missing}, ${corrupt}, ${garbage}) order by id`);
      expect(rows.map((r) => [Number(r.id), r.released])).toEqual([
        [good, true],
        [missing, false],
        [corrupt, false],
        [garbage, false],
      ]);
      expect(result.metrics.released).toBe(1);
      expect(result.metrics.unverified).toBe(3);
    });
  });
});
