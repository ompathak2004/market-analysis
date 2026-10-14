import { pageOf } from "@ma/ingest";
import { describe, expect, it } from "vitest";
import { maskAnalystTurns } from "./concall.js";
import {
  claimConfidence,
  groundClaims,
  isGenericName,
  type LlmDocument,
  llmDocumentCost,
  llmInputsHash,
  shapeClaim,
} from "./extract.js";
import {
  type GroundedClaim,
  groundClaim,
  locateQuote,
  namesCounterparty,
  pctGrounded,
} from "./grounding.js";
import { isLlmSourceName, LLM_SOURCES, planLlmDocuments } from "./index.js";
import { type RelationshipClaim, relationshipExtractionSchema } from "./schemas.js";
import { RELATIONSHIP_CUES, type Section, selectSections } from "./sections.js";

const claim = (c: Partial<RelationshipClaim>): RelationshipClaim => ({
  evidenceId: "S1",
  quote: "",
  counterparty: "Maruti Suzuki India Limited",
  counterpartyKind: "company",
  role: "customer",
  disclosureKind: "major_customer",
  costBucket: "COGS",
  valueBasis: "revenue_share",
  pct: null,
  amount: null,
  orderStatus: null,
  confidence: 0.9,
  ...c,
});

const section = (text: string, start = 0, end = text.length): Section => ({
  evidenceId: "S1",
  start,
  end,
  text: text.slice(start, end),
  score: 5,
});

describe("relationship claim schema", () => {
  it("accepts a well-formed claim set", () => {
    const parsed = relationshipExtractionSchema.parse({
      claims: [claim({ quote: "x", pct: 21 })],
    });
    expect(parsed.claims).toHaveLength(1);
  });

  it("rejects unknown roles and missing fields", () => {
    expect(() =>
      relationshipExtractionSchema.parse({ claims: [{ ...claim({}), role: "competitor" }] }),
    ).toThrow();
    const { confidence: _drop, ...partial } = claim({});
    expect(() => relationshipExtractionSchema.parse({ claims: [partial] })).toThrow();
  });
});

describe("grounding", () => {
  const text =
    "Segment information.\nRevenue from Maruti Suzuki India\n  Limited accounted for 21.5% of the\ttotal revenue from operations in FY25.";

  it("relocates a quote across whitespace and line-break differences", () => {
    const quote =
      "Revenue from Maruti Suzuki India Limited accounted for 21.5% of the total revenue";
    const span = locateQuote(text, quote);
    expect(span).not.toBeNull();
    expect(text.slice(span?.start, span?.end)).toBe(
      "Revenue from Maruti Suzuki India\n  Limited accounted for 21.5% of the\ttotal revenue",
    );
  });

  it("folds curly quotes, dashes and case", () => {
    const t = "The company\u2019s largest customer \u2014 Tata Motors \u2014 took 30% of sales.";
    const span = locateQuote(t, "the company's largest customer - tata motors - took 30% of sales");
    expect(span).toEqual({ start: 0, end: t.length - 1 });
  });

  it("rejects quotes that are too short or outside the cited section", () => {
    expect(locateQuote(text, "Maruti")).toBeNull();
    const quote = "Revenue from Maruti Suzuki India Limited accounted for 21.5%";
    expect(locateQuote(text, quote, 60)).toBeNull();
  });

  it("maps grounded offsets to pages", () => {
    const pageMap = [
      { page: 1, start: 0, end: 21 },
      { page: 2, start: 21, end: text.length },
    ];
    const g = groundClaim(
      claim({
        quote: "Revenue from Maruti Suzuki India Limited accounted for 21.5% of the total revenue",
        pct: 21.5,
      }),
      [section(text)],
      text,
    );
    expect(typeof g).not.toBe("string");
    expect(pageOf(pageMap, (g as GroundedClaim).start)).toBe(2);
  });

  it("names the failure for each ungrounded claim", () => {
    const quote =
      "Revenue from Maruti Suzuki India Limited accounted for 21.5% of the total revenue";
    const s = [section(text)];
    expect(groundClaim(claim({ quote, evidenceId: "S9" }), s, text)).toBe("unknown_section");
    expect(groundClaim(claim({ quote: `${quote} and more words` }), s, text)).toBe(
      "quote_not_found",
    );
    expect(groundClaim(claim({ quote, counterparty: "Hyundai Motor" }), s, text)).toBe(
      "counterparty_not_quoted",
    );
    expect(groundClaim(claim({ quote, pct: 25 }), s, text)).toBe("pct_not_quoted");
    expect(groundClaim(claim({ quote, amount: "Rs 500 crore" }), s, text)).toBe(
      "amount_not_quoted",
    );
  });

  it("counts role and grounding failures", () => {
    const quote =
      "Revenue from Maruti Suzuki India Limited accounted for 21.5% of the total revenue";
    const r = groundClaims(
      [claim({ quote, pct: 21.5 }), claim({ quote, role: "supplier" }), claim({ quote: "nope" })],
      [section(text)],
      text,
      ["customer"],
    );
    expect(r.grounded).toHaveLength(1);
    expect(r.failures).toEqual({ role: 1, quote_not_found: 1 });
  });

  it("matches counterparty names and percentages from the quote only", () => {
    expect(namesCounterparty("supplies to Tata Motors Ltd.", "Tata Motors Limited")).toBe(true);
    expect(namesCounterparty("supplies to Tata Steel", "Tata Motors")).toBe(false);
    expect(pctGrounded("about 21.5% of revenue", 21.5)).toBe(true);
    expect(pctGrounded("about 21.5% of revenue", 12)).toBe(false);
  });
});

describe("section selection", () => {
  const filler = "The board reviewed general matters of governance and compliance. ".repeat(40);
  const doc = [
    filler,
    "Our largest customer accounted for 18% of revenue. Major customers include Bharat Electronics and supplies to Indian Railways.",
    filler,
    "We source steel from Tata Steel. Sales to our key customer grew; customers and suppliers remain stable.",
    filler,
  ].join("\n\n");

  it("is deterministic and keeps offsets into the original text", () => {
    const a = selectSections(doc, RELATIONSHIP_CUES, { budgetTokens: 2_000 });
    const b = selectSections(doc, RELATIONSHIP_CUES, { budgetTokens: 2_000 });
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(0);
    expect(a.map((s) => s.evidenceId)).toEqual(a.map((_, i) => `S${i + 1}`));
    for (const s of a) {
      expect(doc.slice(s.start, s.end).replace(/\s+/g, " ").trim()).toBe(s.text);
    }
  });

  it("respects the token budget and the minimum score", () => {
    expect(selectSections(doc, RELATIONSHIP_CUES, { budgetTokens: 10 })).toEqual([]);
    expect(selectSections(filler, RELATIONSHIP_CUES, { budgetTokens: 2_000 })).toEqual([]);
  });

  it("changes the inputs hash when the layout, model or revision changes", () => {
    const sections = selectSections(doc, RELATIONSHIP_CUES, { budgetTokens: 2_000 });
    const base = llmInputsHash("sha", 101, "model-a", sections);
    expect(llmInputsHash("sha", 101, "model-a", sections)).toBe(base);
    expect(llmInputsHash("sha", 101, "model-b", sections)).not.toBe(base);
    expect(llmInputsHash("sha2", 101, "model-a", sections)).not.toBe(base);
    expect(llmInputsHash("sha", 101, "model-a", sections.slice(1))).not.toBe(base);
  });
});

describe("claim shaping", () => {
  const grounded = (c: Partial<RelationshipClaim>, g: Partial<GroundedClaim> = {}) =>
    ({
      claim: claim(c),
      quote: "Maruti Suzuki accounted for 21.5% of revenue",
      start: 0,
      end: 10,
      pct: c.pct ?? null,
      money: null,
      ...g,
    }) as GroundedClaim;

  it("keeps a percentage only for share claims that quote one", () => {
    expect(shapeClaim(grounded({ pct: 21.5 }))).toMatchObject({
      valueBasis: "revenue_share",
      cueClass: "revenue_share",
      pct: 21.5,
    });
    expect(shapeClaim(grounded({ pct: null }))).toMatchObject({
      valueBasis: "unknown",
      cueClass: "mention",
      pct: null,
    });
  });

  it("turns orders into contract totals and never into annual flows", () => {
    const money = { amount: 500, currency: "INR" as const, valueCr: 500, start: 0, end: 12 };
    const shaped = shapeClaim(
      grounded(
        { valueBasis: "unknown", disclosureKind: "contract", amount: "Rs 500 crore" },
        { money },
      ),
    );
    expect(shaped).toMatchObject({
      valueBasis: "contract_total",
      cueClass: "order",
      valueCr: 500,
      orderStatus: "awarded",
    });
  });

  it("drops an annual flow without a quoted amount", () => {
    expect(shapeClaim(grounded({ valueBasis: "annual_flow" })).valueBasis).toBe("unknown");
  });

  it("caps confidence by source and penalises new counterparties", () => {
    expect(claimConfidence(claim({ confidence: 0.95 }), { maxConfidence: 0.85 }, false)).toBe(0.85);
    expect(claimConfidence(claim({ confidence: 0.95 }), { maxConfidence: 0.85 }, true)).toBe(0.75);
    expect(claimConfidence(claim({ confidence: -1 }), { maxConfidence: 0.85 }, true)).toBe(0);
  });

  it("recognises generic counterparty names", () => {
    expect(isGenericName("a leading OEM")).toBe(true);
    expect(isGenericName("Government of India")).toBe(false);
    expect(isGenericName("PSU utilities")).toBe(true);
    expect(isGenericName("Bharat Electronics")).toBe(false);
  });
});

describe("concall preparation", () => {
  it("blanks analyst and moderator turns while keeping offsets", () => {
    const transcript = [
      "Moderator: The next question is from the line of Rahul Mehta from Alpha Capital.",
      "Rahul Mehta: Who are your largest customers this year?",
      "Anil Kumar: Our largest customer is Maruti Suzuki, which is 20% of revenue.",
    ].join("\n");
    const masked = maskAnalystTurns(transcript);
    expect(masked).toHaveLength(transcript.length);
    expect(masked.split("\n")).toHaveLength(3);
    expect(masked).not.toContain("Who are your largest customers");
    expect(masked).not.toContain("Moderator");
    expect(masked).toContain("Our largest customer is Maruti Suzuki");
    const at = transcript.indexOf("Our largest");
    expect(masked.indexOf("Our largest")).toBe(at);
  });

  it("leaves text without speaker turns unchanged", () => {
    expect(maskAnalystTurns("Plain paragraph about customers.")).toBe(
      "Plain paragraph about customers.",
    );
  });
});

describe("llm document planning", () => {
  const doc = (documentId: number): LlmDocument => ({
    companyId: 1,
    family: "annual_report",
    documentId,
    revisionId: documentId * 10,
    url: `https://example.com/${documentId}`,
    contentType: null,
    label: null,
    publishedAt: null,
  });

  it("interleaves sources and stops at the token budget", () => {
    const annual = llmDocumentCost(LLM_SOURCES.annual_report);
    const ratings = llmDocumentCost(LLM_SOURCES.rating_rationale);
    const plan = planLlmDocuments(
      [
        { source: "annual_report", docs: [doc(1), doc(2)] },
        { source: "rating_rationale", docs: [doc(3), doc(4)] },
      ],
      annual + ratings * 2,
    );
    expect(plan.map((p) => [p.source, p.documentId, p.revisionId])).toEqual([
      ["annual_report", 1, 10],
      ["rating_rationale", 3, 30],
      ["rating_rationale", 4, 40],
    ]);
    expect(planLlmDocuments([{ source: "annual_report", docs: [doc(1)] }], 0)).toEqual([]);
  });

  it("validates source names", () => {
    expect(isLlmSourceName("concall")).toBe(true);
    expect(isLlmSourceName("screener")).toBe(false);
  });
});
