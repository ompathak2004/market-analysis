import { createLogger, MemoryObjectStore } from "@ma/core";
import { closeDb, companies, createDb, type Db, fencedTransaction, inArray, sql } from "@ma/db";
import {
  DocumentStore,
  type ExtractionUnit,
  type Firecrawl,
  type HttpClient,
  loadCounterpartyMatcher,
  nextGraphRevision,
  RELATIONSHIP_EXTRACTOR_VERSION,
  registerSource,
  syncCounterparties,
  writeExtraction,
} from "@ma/ingest";
import { LlmClient } from "@ma/llm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ANNUAL_LLM_EXTRACTOR_VERSION, ANNUAL_LLM_SOURCE } from "./annual.js";
import { extractLlmDocument, type LlmDocument, loadLlmDocument } from "./extract.js";

const url = process.env.DATABASE_URL_TEST;

function letters(n: number): string {
  return Array.from({ length: n }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26)))
    .join("")
    .replace(/^./, (c) => c.toUpperCase());
}

describe.skipIf(!url)("llm relationship extraction (DATABASE_URL_TEST)", () => {
  let db: Db;
  let docs: DocumentStore;
  const logger = createLogger("test", "silent");
  const tag = letters(7);
  const focalName = `Quorvane ${tag} Components Limited`;
  const customerName = `Brelmont ${tag} Motors Limited`;
  const supplierName = `Ostrava ${tag} Alloys`;
  const customerQuote = `Revenue from ${customerName} accounted for 24.5% of the total revenue from operations`;
  const supplierQuote = `We purchase steel from ${supplierName}, our key supplier of raw materials`;
  const text = [
    "Directors report. The board met six times during the year.",
    `Information about major customers. ${customerQuote} of the Company during the year. Revenue from no other single customer exceeded 10% or more of the total revenue.`,
    `${supplierQuote}. Our customers and suppliers remain stable.`,
  ].join("\n\n");
  let focalId = 0;
  let customerId = 0;
  let doc: LlmDocument;
  let calls = 0;

  const llm = new LlmClient({
    apiKey: "k",
    model: "test-model",
    fallbackModel: "test-fallback",
    logger,
    budget: null,
    fetch: (async () => {
      calls++;
      const claim = {
        evidenceId: "S1",
        counterpartyKind: "company",
        costBucket: "COGS",
        amount: null,
        orderStatus: null,
      };
      const claims = [
        {
          ...claim,
          quote: customerQuote,
          counterparty: customerName,
          role: "customer",
          disclosureKind: "major_customer",
          valueBasis: "revenue_share",
          pct: 24.5,
          confidence: 0.9,
        },
        {
          ...claim,
          quote: supplierQuote,
          counterparty: supplierName,
          role: "supplier",
          disclosureKind: "press",
          valueBasis: "unknown",
          pct: null,
          confidence: 0.8,
        },
        {
          ...claim,
          quote: "Revenue from Imaginary Holdings accounted for 50% of the total revenue",
          counterparty: "Imaginary Holdings",
          role: "customer",
          disclosureKind: "major_customer",
          valueBasis: "revenue_share",
          pct: 50,
          confidence: 0.9,
        },
      ];
      return Response.json({
        choices: [{ message: { content: JSON.stringify({ claims }) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      });
    }) as unknown as typeof fetch,
    sleep: async () => {},
  });

  async function writeRegex(): Promise<void> {
    const matcher = await loadCounterpartyMatcher(db);
    const focal = matcher.byCompany.get(focalId);
    const customer = matcher.byCompany.get(customerId);
    if (!focal || !customer) throw new Error("missing counterparties");
    const revision = await docs.revision(doc.revisionId);
    const unit: ExtractionUnit = {
      companyId: focalId,
      family: "annual_report",
      extractorVersion: RELATIONSHIP_EXTRACTOR_VERSION,
      inputsHash: `regex-${tag}`,
      documentId: doc.documentId,
      revisionId: doc.revisionId,
      pageMap: revision?.pageMap ?? null,
      graphRevision: await nextGraphRevision(db, focalId),
    };
    const start = text.indexOf("Information about major customers");
    await fencedTransaction(db, (tx) =>
      writeExtraction(tx, unit, {
        observations: [
          {
            supplier: { counterpartyId: focal.counterpartyId, companyId: focalId, name: focalName },
            customer: {
              counterpartyId: customer.counterpartyId,
              companyId: customerId,
              name: customerName,
            },
            disclosedBy: "supplier",
            disclosureKind: "major_customer",
            costBucket: "COGS",
            valueBasis: "unknown",
            cueClass: "mention",
            pct: null,
            valueCr: null,
            currency: null,
            period: { start: null, end: null, fiscalYear: null },
            orderStatus: null,
            claim: "Information about major customers",
            confidence: 0.9,
            matched: customerName,
            newCounterparty: false,
            start,
            end: start + "Information about major customers".length,
          },
        ],
        dropped: 0,
      }),
    );
  }

  async function observationsBy(version: "llm" | "regex") {
    return db.execute<{
      status: string;
      cue_class: string;
      pct: number | null;
      new_counterparty: boolean;
      quote: string;
      start_offset: number;
      end_offset: number;
      counterparty: string;
    }>(sql`
      select o.status, o.cue_class, o.pct, o.new_counterparty, s.quote, s.start_offset,
        s.end_offset,
        case when o.supplier_counterparty_id = f.id then cc.canonical_name else sc.canonical_name end as counterparty
      from relationship_observations o
      join relationship_extractions e on e.id = o.extraction_id
      join relationship_observation_evidence oe on oe.observation_id = o.id
      join evidence_spans s on s.id = oe.evidence_span_id
      join counterparties f on f.company_id = ${focalId}
      join counterparties sc on sc.id = o.supplier_counterparty_id
      join counterparties cc on cc.id = o.customer_counterparty_id
      where o.focal_company_id = ${focalId}
        and e.extractor_version ${version === "llm" ? sql`>=` : sql`<`} 100
      order by s.start_offset`);
  }

  async function readVersion(): Promise<number | null> {
    const [row] = await db.execute<{ v: number | null }>(sql`
      select read_extractor_version as v from relationship_sources
      where company_id = ${focalId} and document_id = ${doc.documentId}`);
    return row?.v ?? null;
  }

  beforeAll(async () => {
    db = createDb(url ?? "", 1);
    docs = new DocumentStore(
      db,
      {} as HttpClient,
      {} as Firecrawl,
      logger,
      new MemoryObjectStore(),
    );
    const rows = await db
      .insert(companies)
      .values([
        { name: focalName, normalizedName: focalName.toLowerCase(), listed: true },
        { name: customerName, normalizedName: customerName.toLowerCase(), listed: true },
      ])
      .returning({ id: companies.id });
    focalId = rows[0]?.id ?? 0;
    customerId = rows[1]?.id ?? 0;
    await syncCounterparties(db);
    const stored = await docs.putInline(`https://example.com/${tag}/annual-report-2025.txt`, text, {
      source: "test",
      companyId: focalId,
    });
    await fencedTransaction(db, (tx) =>
      registerSource(tx, {
        companyId: focalId,
        family: "annual_report",
        documentId: stored.doc.id,
        label: "Annual Report 2024-25",
        publishedAt: "2025-07-15",
      }),
    );
    const loaded = await loadLlmDocument(db, ANNUAL_LLM_SOURCE, focalId, stored.doc.id);
    if (!loaded) throw new Error("annual report not registered");
    doc = loaded;
  });

  afterAll(async () => {
    const ids = [focalId, customerId];
    await db.execute(sql`
      delete from relationships
      where supplier_company_id in (${focalId}, ${customerId})
        or customer_company_id in (${focalId}, ${customerId})`);
    await db.execute(
      sql`delete from relationship_observations where focal_company_id = ${focalId}`,
    );
    await db.execute(sql`delete from documents where company_id in (${focalId}, ${customerId})`);
    await db.execute(sql`
      delete from counterparties
      where company_id in (${focalId}, ${customerId}) or normalized_name like ${`%${tag.toLowerCase()}%`}`);
    await db.delete(companies).where(inArray(companies.id, ids));
    await closeDb(db);
  });

  it("lists the annual report as pending for the llm adapter", async () => {
    const pending = await ANNUAL_LLM_SOURCE.pending(db, { companyId: focalId, limit: 5 });
    expect(pending.map((d) => d.documentId)).toEqual([doc.documentId]);
  });

  it("writes grounded claims next to regex observations without touching the read marker", async () => {
    await writeRegex();
    expect(await readVersion()).toBe(RELATIONSHIP_EXTRACTOR_VERSION);

    const result = await extractLlmDocument({ db, llm, logger, docs }, ANNUAL_LLM_SOURCE, doc);
    expect(result).toMatchObject({ status: "extracted", observations: 2, dropped: 1, tokens: 120 });

    const llmRows = await observationsBy("llm");
    expect(
      llmRows.map((r) => ({
        status: r.status,
        cue: r.cue_class,
        pct: r.pct,
        created: r.new_counterparty,
        counterparty: r.counterparty,
      })),
    ).toEqual([
      {
        status: "auto",
        cue: "revenue_share",
        pct: 24.5,
        created: false,
        counterparty: customerName,
      },
      { status: "pending", cue: "mention", pct: null, created: true, counterparty: supplierName },
    ]);
    for (const r of llmRows) expect(text.slice(r.start_offset, r.end_offset)).toBe(r.quote);
    expect(llmRows[0]?.quote).toBe(customerQuote);

    expect(await observationsBy("regex")).toHaveLength(1);
    expect(await readVersion()).toBe(RELATIONSHIP_EXTRACTOR_VERSION);

    const [ledger] = await db.execute<{
      tokens: number;
      observations: number;
      dropped: number;
    }>(sql`
      select tokens, observations, dropped from relationship_extractions
      where document_revision_id = ${doc.revisionId}
        and extractor_version = ${ANNUAL_LLM_EXTRACTOR_VERSION}`);
    expect(ledger).toEqual({ tokens: 120, observations: 2, dropped: 1 });
  });

  it("keeps llm observations when the regex extractor rewrites the document", async () => {
    await writeRegex();
    expect(await observationsBy("llm")).toHaveLength(2);
    expect(await observationsBy("regex")).toHaveLength(1);
  });

  it("skips an unchanged revision without calling the model again", async () => {
    const before = calls;
    const result = await extractLlmDocument({ db, llm, logger, docs }, ANNUAL_LLM_SOURCE, doc);
    expect(result.status).toBe("skipped");
    expect(calls).toBe(before);
    expect(await ANNUAL_LLM_SOURCE.pending(db, { companyId: focalId, limit: 5 })).toEqual([]);
  });
});
