import { randomInt, randomUUID } from "node:crypto";
import { closeDb, createDb, type Db, sql } from "@ma/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "../context";
import { companyLogistics } from "./altdata";

const url = process.env.DATABASE_URL_TEST;

describe.skipIf(!url)("company logistics relevance (DATABASE_URL_TEST)", () => {
  let db: Db;
  let companyId: number;
  let facilityId: number;
  const symbol = `SEA${randomUUID().slice(0, 8).toUpperCase()}`;
  const linkedMmsi = randomInt(800000000, 899999998);
  const otherMmsi = linkedMmsi + 1;
  const ctx = () =>
    ({
      db,
      api: { getOrLoad: <T>(_key: string, load: () => Promise<T>) => load() },
      cache: { getOrLoad: <T>(_key: string, load: () => Promise<T>) => load() },
      yahoo: { quote: async () => null },
    }) as unknown as AppContext;

  beforeAll(async () => {
    db = createDb(url ?? "", 1);
    const [company] = await db.execute<{ id: number }>(
      sql`insert into companies (name, normalized_name, nse_symbol) values (${symbol}, ${symbol}, ${symbol}) returning id`,
    );
    if (!company) throw new Error("Company missing");
    companyId = company.id;
    const [facility] = await db.execute<{ id: number }>(
      sql`insert into facilities (slug, name, kind, lat, lon, radius_km) values (${symbol}, ${symbol}, 'port', 22.45, 69.75, 10) returning id`,
    );
    if (!facility) throw new Error("Facility missing");
    facilityId = facility.id;
    await db.execute(
      sql`insert into facility_companies (facility_id, company_id, role) values (${facilityId}, ${companyId}, 'owner')`,
    );
    for (const mmsi of [linkedMmsi, otherMmsi]) {
      await db.execute(
        sql`insert into vessels (mmsi, first_seen_at, last_seen_at) values (${mmsi}, now(), now())`,
      );
      await db.execute(
        sql`insert into vessel_positions (mmsi, ts, lat, lon) values (${mmsi}, now(), 22.45, 69.75)`,
      );
    }
    await db.execute(
      sql`insert into vessel_calls (mmsi, facility_id, entered_at, left_at, dwell_min, ended_by) values (${linkedMmsi}, ${facilityId}, now() - interval '12 hours', now() - interval '2 hours', 600, 'timeout')`,
    );
  });

  afterAll(async () => {
    await db.execute(sql`delete from facilities where id = ${facilityId}`);
    await db.execute(sql`delete from vessels where mmsi in (${linkedMmsi}, ${otherMmsi})`);
    await db.execute(sql`delete from companies where id = ${companyId}`);
    await closeDb(db);
  });

  it("excludes unrelated nearby traffic and exposes coverage timeouts", async () => {
    const view = await companyLogistics(ctx(), symbol);
    expect(view?.positionsForMap.map((p) => p.mmsi)).toEqual([linkedMmsi]);
    expect(view?.positionsForMap[0]?.linkage).toBe("facility call");
    expect(view?.calls[0]?.endedBy).toBe("timeout");
    expect(view?.coverage.factor7d).toBe(0);
  });
});
