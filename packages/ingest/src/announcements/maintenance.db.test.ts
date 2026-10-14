import { randomUUID } from "node:crypto";
import { MemoryObjectStore } from "@ma/core";
import { closeDb, createDb, type Db, sql, type Tx } from "@ma/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backupAnnouncements, readBackup, verifyBackup } from "./backup.js";
import {
  ANNOUNCEMENT_DOCUMENT_PREFIX,
  classifyAnnouncementRange,
  classifyRanges,
  deleteExpiredAnnouncements,
  reindexAnnouncements,
  unclassifiedAnnouncements,
} from "./maintenance.js";
import { ANNOUNCEMENT_POLICY_VERSION } from "./policy.js";

const url = process.env.DATABASE_URL_TEST;
const KEY = "a".repeat(64);

class Rollback extends Error {}

async function rolledBack(db: Db, fn: (tx: Tx) => Promise<void>): Promise<void> {
  await db
    .transaction(async (tx) => {
      await fn(tx);
      throw new Rollback();
    })
    .catch((err: unknown) => {
      if (!(err instanceof Rollback)) throw err;
    });
}

describe.skipIf(!url)("announcement maintenance (DATABASE_URL_TEST)", () => {
  let db: Db;
  const tag = `ann-${randomUUID().slice(0, 8)}`;

  beforeAll(() => {
    db = createDb(url ?? "", 2);
  });

  afterAll(async () => {
    await closeDb(db);
  });

  async function seedCompany(tx: Tx): Promise<number> {
    const rows = await tx.execute<{ id: number }>(sql`
      insert into companies (name, normalized_name) values (${tag}, ${tag}) returning id`);
    return Number(rows[0]?.id);
  }

  async function announcement(
    tx: Tx,
    companyId: number,
    row: {
      subject: string;
      retentionClass?: string | null;
      retainUntil?: string | null;
      policyVersion?: number;
      attachmentUrl?: string | null;
      publishedAt?: string;
    },
  ): Promise<number> {
    const rows = await tx.execute<{ id: number }>(sql`
      insert into announcements (company_id, published_at, subject, attachment_url, dedupe_key,
        retention_class, retain_until, policy_version)
      values (${companyId}, ${row.publishedAt ?? "2015-03-02T10:00:00Z"}, ${row.subject},
        ${row.attachmentUrl ?? null}, ${`${tag}-${randomUUID()}`}, ${row.retentionClass ?? null},
        ${row.retainUntil ?? null}, ${row.policyVersion ?? ANNOUNCEMENT_POLICY_VERSION})
      returning id`);
    return Number(rows[0]?.id);
  }

  async function cite(tx: Tx, docUrl: string, source: string): Promise<number> {
    const docs = await tx.execute<{ id: number }>(sql`
      insert into documents (url, source, sha256, byte_size)
      values (${docUrl}, ${source}, ${tag}, 10) returning id`);
    const revs = await tx.execute<{ id: number }>(sql`
      insert into document_revisions (document_id, content_sha256, text_bytes)
      values (${docs[0]?.id}, ${tag}, 10) returning id`);
    const spans = await tx.execute<{ id: number }>(sql`
      insert into evidence_spans (document_revision_id, start_offset, end_offset, quote)
      values (${revs[0]?.id}, 0, 5, 'order') returning id`);
    return Number(spans[0]?.id);
  }

  async function surviving(tx: Tx, ids: number[]): Promise<number[]> {
    const rows = await tx.execute<{ id: number }>(sql`
      select id from announcements where id in (${sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `,
      )}) order by id`);
    return rows.map((r) => Number(r.id));
  }

  it("classifies unversioned rows in id ranges", async () => {
    await rolledBack(db, async (tx) => {
      const companyId = await seedCompany(tx);
      const noise = await announcement(tx, companyId, {
        subject: "Closure of Trading Window",
        policyVersion: 0,
      });
      const kept = await announcement(tx, companyId, {
        subject: "Financial Results for the quarter ended June 30, 2015",
        policyVersion: 0,
      });
      const maxId = Math.max(noise, kept);
      expect(await unclassifiedAnnouncements(tx, maxId)).toBeGreaterThanOrEqual(2);
      const ranges = await classifyRanges(tx, maxId, 1);
      expect(ranges.length).toBeGreaterThanOrEqual(2);
      for (const range of ranges) await classifyAnnouncementRange(tx, range);
      expect(await unclassifiedAnnouncements(tx, maxId)).toBe(0);
      const rows = await tx.execute<{ id: number; retention_class: string; retain_until: string }>(
        sql`select id, retention_class, retain_until::text from announcements
          where id in (${noise}, ${kept}) order by id`,
      );
      expect(rows.map((r) => r.retention_class)).toEqual(["noise", "forever"]);
      expect(rows[0]?.retain_until).toBe("2015-03-02");
    });
  });

  it("deletes noise and expired rows but never held or cited ones", async () => {
    await rolledBack(db, async (tx) => {
      const companyId = await seedCompany(tx);
      const past = "2016-01-01";
      const noise = await announcement(tx, companyId, {
        subject: "Trading window",
        retentionClass: "noise",
        retainUntil: past,
      });
      const pinned = await announcement(tx, companyId, {
        subject: "Trading window",
        retentionClass: "noise",
        retainUntil: past,
      });
      await tx.execute(sql`
        insert into announcement_holds (announcement_id, reason) values (${pinned}, 'legal')`);
      const citedById = await announcement(tx, companyId, {
        subject: "Trading window",
        retentionClass: "noise",
        retainUntil: past,
      });
      await cite(tx, `${ANNOUNCEMENT_DOCUMENT_PREFIX}${citedById}`, "order_filing");
      const attachment = `https://nsearchives.nseindia.com/${tag}.pdf`;
      const citedByUrl = await announcement(tx, companyId, {
        subject: "Credit rating",
        retentionClass: "five_years",
        retainUntil: past,
        attachmentUrl: attachment,
      });
      await cite(tx, attachment, "announcement_metadata");
      const citedByRating = await announcement(tx, companyId, {
        subject: "Credit rating",
        retentionClass: "five_years",
        retainUntil: past,
      });
      await cite(tx, `${ANNOUNCEMENT_DOCUMENT_PREFIX}${citedByRating}/rating`, "rating_rationale");
      const expired = await announcement(tx, companyId, {
        subject: "Credit rating",
        retentionClass: "five_years",
        retainUntil: past,
      });
      const live = await announcement(tx, companyId, {
        subject: "Credit rating",
        retentionClass: "five_years",
        retainUntil: "2999-01-01",
      });
      const forever = await announcement(tx, companyId, {
        subject: "Acquisition",
        retentionClass: "forever",
      });
      const maxId = forever;
      const later = await announcement(tx, companyId, {
        subject: "Trading window",
        retentionClass: "noise",
        retainUntil: past,
      });
      const result = await deleteExpiredAnnouncements(tx, {
        maxId,
        expired: () => false,
        batch: 1,
        pauseMs: 0,
      });
      expect(result.complete).toBe(true);
      expect(result.held).toBeGreaterThanOrEqual(3);
      const ids = [
        noise,
        pinned,
        citedById,
        citedByUrl,
        citedByRating,
        expired,
        live,
        forever,
        later,
      ];
      expect(await surviving(tx, ids)).toEqual([
        pinned,
        citedById,
        citedByUrl,
        citedByRating,
        live,
        forever,
        later,
      ]);
      const holds = await tx.execute<{ announcement_id: number; reason: string }>(sql`
        select announcement_id, reason from announcement_holds
        where announcement_id in (${pinned}, ${citedById}, ${citedByUrl}, ${citedByRating})
        order by announcement_id, reason`);
      expect(holds.map((h) => [Number(h.announcement_id), h.reason])).toEqual([
        [pinned, "legal"],
        [citedById, "evidence"],
        [citedByUrl, "evidence"],
        [citedByRating, "evidence"],
      ]);
      const classes = await tx.execute<{ retention_class: string }>(sql`
        select retention_class from announcements where id = ${citedById}`);
      expect(classes[0]?.retention_class).toBe("review_hold");
    });
  });

  it("stops when the deadline is reached", async () => {
    await rolledBack(db, async (tx) => {
      const companyId = await seedCompany(tx);
      const id = await announcement(tx, companyId, {
        subject: "Trading window",
        retentionClass: "noise",
        retainUntil: "2016-01-01",
      });
      const result = await deleteExpiredAnnouncements(tx, {
        maxId: id,
        expired: () => true,
      });
      expect(result.complete).toBe(false);
      expect(await surviving(tx, [id])).toEqual([id]);
    });
  });

  it("writes an encrypted backup that verifies and restores", async () => {
    await rolledBack(db, async (tx) => {
      const companyId = await seedCompany(tx);
      const id = await announcement(tx, companyId, { subject: `Backup ${tag}` });
      const objects = new MemoryObjectStore();
      const backup = await backupAnnouncements(tx, objects, {
        day: "2026-10-14",
        maxId: id,
        encryptionKey: KEY,
        chunkRows: 2,
      });
      expect(backup.key).toBe("backups/announcements-2026-10-14.ndjson.gz.enc");
      expect(backup.encrypted).toBe(true);
      expect(await verifyBackup(tx, objects, backup.key)).not.toBeNull();
      const body = await objects.get(backup.key);
      if (!body) throw new Error("backup missing");
      const lines = await readBackup(body, KEY);
      expect(lines).toHaveLength(backup.rows);
      expect(lines.map((l) => JSON.parse(l) as { id: number }).some((r) => r.id === id)).toBe(true);
      await expect(readBackup(body, "b".repeat(64))).rejects.toThrow();
      await objects.put(backup.key, new Uint8Array([1, 2, 3]), backup.sha256);
      expect(await verifyBackup(tx, objects, backup.key)).toBeNull();
    });
  });

  it("reindexes the announcement indexes concurrently", async () => {
    const result = await reindexAnnouncements(db);
    expect(result.reindexed + result.denied).toBeGreaterThanOrEqual(4);
  });
});
