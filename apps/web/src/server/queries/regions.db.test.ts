import { randomUUID } from "node:crypto";
import { closeDb, createDb, type Db, sql } from "@ma/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { regionalExposure } from "./regions";

const url = process.env.DATABASE_URL_TEST;

describe.skipIf(!url)("regional exposure (DATABASE_URL_TEST)", () => {
  let db: Db;
  let companyId: number;
  let documentId: number;
  let revisionId: number;
  const tag = `REG${randomUUID().slice(0, 8)}`;
  const stateCode = "IN-XZ";

  beforeAll(async () => {
    db = createDb(url ?? "", 1);
    const one = async (query: ReturnType<typeof sql>) => {
      const [row] = await db.execute<{ id: number }>(query);
      if (!row) throw new Error("Fixture missing");
      return row.id;
    };
    companyId = await one(
      sql`insert into companies (name, normalized_name, nse_symbol) values (${tag}, ${tag}, ${tag}) returning id`,
    );
    documentId = await one(
      sql`insert into documents (url, source, company_id, sha256, byte_size) values (${`https://example.test/${tag}`}, 'company_locations', ${companyId}, ${tag}, 100) returning id`,
    );
    revisionId = await one(
      sql`insert into document_revisions (document_id, content_sha256, text_bytes) values (${documentId}, ${tag}, 100) returning id`,
    );
    const span = await one(
      sql`insert into evidence_spans (document_revision_id, start_offset, end_offset, quote) values (${revisionId}, 0, 10, 'Plant in XZ') returning id`,
    );
    await db.execute(
      sql`update documents set current_revision_id = ${revisionId} where id = ${documentId}`,
    );
    await db.execute(
      sql`insert into company_operating_sites (company_id, document_id, name, state_code, evidence_span_id, observed_on) values (${companyId}, ${documentId}, 'Disclosed plant', ${stateCode}, ${span}, current_date)`,
    );
    await db.execute(
      sql`insert into state_leadership (state_code, state_name, head_name, observed_on, source_reviewed_on, evidence_span_id, parser_version) values (${stateCode}, 'Test jurisdiction', 'Test officeholder', current_date, current_date - 40, ${span}, 1)`,
    );
  });

  afterAll(async () => {
    await db.execute(sql`delete from state_leadership where state_code = ${stateCode}`);
    await db.execute(sql`delete from companies where id = ${companyId}`);
    await db.execute(sql`delete from documents where id = ${documentId}`);
    await closeDb(db);
  });

  it("shows source-backed sites and marks an old official review stale", async () => {
    const [row] = await regionalExposure({ db }, companyId);
    expect(row?.facility).toBe("Disclosed plant");
    expect(row?.headName).toBe("Test officeholder");
    expect(row?.freshness).toBe("stale");
    expect(row?.evidence).toHaveLength(2);
    expect(row?.facilityId).toBeNull();
  });

  it("does not serve a site from a superseded document revision", async () => {
    await db.execute(sql`update documents set current_revision_id = null where id = ${documentId}`);
    expect(await regionalExposure({ db }, companyId)).toEqual([]);
  });
});
