import { closeDb, createDb, type Db, sql } from "@ma/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activeSignalVersionClause } from "./signal-versions.js";

const url = process.env.DATABASE_URL_TEST;

describe.skipIf(!url)("active signal version clause (DATABASE_URL_TEST)", () => {
  let db: Db;

  beforeAll(() => {
    db = createDb(url ?? "", 1);
  });

  afterAll(async () => {
    await closeDb(db);
  });

  it("keeps only the active version of mapped kinds and passes other kinds through", async () => {
    const rows = await db.execute<{ kind: string; version: number }>(sql`
      select kind, version from (values
        ('customer_hhi', 2), ('customer_hhi', 3),
        ('customer_momentum_1m', 1), ('customer_momentum_1m', 2),
        ('top3_customers_pct', 2), ('top3_customers_pct', 3),
        ('distress_score', 1), ('gst_filing_score', 7),
        ('travel_coverage', 1), ('travel_coverage', 2),
        ('logistics_dwell_change', 1), ('logistics_dwell_change', 2)
      ) as v(kind, version)
      where ${activeSignalVersionClause(sql`v.kind`, sql`v.version`)}
      order by kind`);
    expect(rows.map((r) => [r.kind, Number(r.version)])).toEqual([
      ["customer_hhi", 3],
      ["customer_momentum_1m", 2],
      ["distress_score", 1],
      ["gst_filing_score", 7],
      ["logistics_dwell_change", 2],
      ["top3_customers_pct", 3],
      ["travel_coverage", 2],
    ]);
  });
});
