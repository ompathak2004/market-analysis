import { randomUUID } from "node:crypto";
import { createLogger } from "@ma/core";
import { closeDb, companies, createDb, type Db, inArray, sql } from "@ma/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IngestContext } from "../context.js";
import type { NseAnnouncement } from "../sources/nse.js";
import { syncAnnouncements } from "./market.js";

const url = process.env.DATABASE_URL_TEST;

describe.skipIf(!url)("announcement sync (DATABASE_URL_TEST)", () => {
  let db: Db;
  let companyId = 0;
  const symbol = `T${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;

  beforeAll(async () => {
    db = createDb(url ?? "", 1);
    const [row] = await db
      .insert(companies)
      .values({
        name: `${symbol} Ltd`,
        normalizedName: symbol.toLowerCase(),
        nseSymbol: symbol,
        listed: true,
      })
      .returning({ id: companies.id });
    companyId = row?.id ?? 0;
  });

  afterAll(async () => {
    await db.execute(sql`delete from announcements where company_id = ${companyId}`);
    await db.delete(companies).where(inArray(companies.id, [companyId]));
    await closeDb(db);
  });

  it("stores one row when NSE repeats an announcement in the same response", async () => {
    const item: NseAnnouncement = {
      symbol,
      companyName: `${symbol} Ltd`,
      subject: "Receipt of order",
      details: "Received an order worth Rs 120 crore from a customer.",
      attachmentUrl: null,
      publishedAt: new Date("2026-10-10T04:30:00Z"),
      industry: null,
      isin: null,
    };
    const ctx = {
      db,
      logger: createLogger("test", "error"),
      nse: { announcements: async () => [item, { ...item }] },
    } as unknown as IngestContext;
    const stats = await syncAnnouncements(ctx, companyId);
    expect(stats).toMatchObject({ fetched: 2, inserted: 1, reclassified: 0 });
    const [count] = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from announcements where company_id = ${companyId}`,
    );
    expect(count?.n).toBe(1);
  });
});
