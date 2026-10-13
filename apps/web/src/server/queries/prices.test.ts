import { randomUUID } from "node:crypto";
import { closeDb, createDb, type Db, sql } from "@ma/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "../context";
import { priceSnapshot } from "./core";

const url = process.env.DATABASE_URL_TEST;

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}

describe.skipIf(!url)("priceSnapshot (DATABASE_URL_TEST)", () => {
  let db: Db;
  const tag = `W${randomUUID().slice(0, 8).toUpperCase()}`;
  const ids: number[] = [];
  const ctx = () =>
    ({
      db,
      api: { getOrLoad: <T>(_k: string, load: () => Promise<T>) => load() },
    }) as unknown as AppContext;

  async function company(sym: string): Promise<number> {
    const [c] = await db.execute<{ id: number }>(sql`
      insert into companies (name, normalized_name, nse_symbol, listing_status)
      values (${sym}, ${sym}, ${sym}, 'active') returning id`);
    ids.push(Number(c?.id));
    return Number(c?.id);
  }

  async function price(id: number, date: string, close: number, g: number, final: boolean) {
    await db.execute(sql`
      insert into prices_daily (company_id, date, close, adj_close, adjustment_generation, is_final)
      values (${id}, ${date}, ${close}, ${close}, ${g}, ${final})`);
  }

  beforeAll(async () => {
    db = createDb(url ?? "", 2);
    const id = await company(`${tag}A`);
    await db.execute(sql`
      insert into price_series_state (company_id, desired_from, desired_to, adjustment_generation,
        quality_status)
      values (${id}, ${daysAgo(30)}, ${daysAgo(2)}, 2, 'partial')`);
    await price(id, daysAgo(4), 90, 1, true);
    await price(id, daysAgo(3), 100, 2, true);
    await price(id, daysAgo(2), 101, 2, false);
    const legacy = await company(`${tag}B`);
    await price(legacy, daysAgo(3), 50, 0, false);
  });

  afterAll(async () => {
    for (const id of ids) {
      await db.execute(sql`delete from price_series_state where company_id = ${id}`);
      await db.execute(sql`delete from prices_daily where company_id = ${id}`);
      await db.execute(sql`delete from companies where id = ${id}`);
    }
    await closeDb(db);
  });

  it("serves only the current generation and flags provisional bars", async () => {
    const snap = await priceSnapshot(ctx(), `${tag}A`, "1mo");
    expect(snap?.bars.map((b) => [b.date, b.close, b.final])).toEqual([
      [daysAgo(3), 100, true],
      [daysAgo(2), 101, false],
    ]);
    expect(snap?.meta).toMatchObject({
      generation: 2,
      quality: "partial",
      finalThrough: daysAgo(3),
      provisional: "flagged",
    });
  });

  it("falls back to the stored generation when a company has no series state yet", async () => {
    const snap = await priceSnapshot(ctx(), `${tag}B`, "1mo");
    expect(snap?.bars.map((b) => [b.date, b.final])).toEqual([[daysAgo(3), false]]);
    expect(snap?.meta).toMatchObject({ generation: 0, quality: null, finalThrough: null });
  });
});
