import { addYears, isoDate } from "@ma/core";
import { companies, companyAliases, eq, relationships, signals, sql } from "@ma/db";
import type { IngestContext } from "../context.js";
import {
  type AliasEntry,
  type AliasMatcher,
  buildAliasMatcher,
  extractConcentration,
  extractNamedMentions,
  extractTopCustomerShares,
  RELATIONSHIP_EXTRACTOR_VERSION,
  toCrore,
} from "../extract/relationships.js";

const YEAR_MS = 365 * 86_400_000;

export interface RelationshipExtractionResult {
  documents: number;
  relationships: number;
  concentration: number | null;
}

export async function loadAliasMatcher(ctx: IngestContext): Promise<AliasMatcher> {
  const rows = await ctx.db
    .select({
      companyId: companyAliases.companyId,
      alias: companyAliases.alias,
      name: companies.name,
      symbol: companies.nseSymbol,
    })
    .from(companyAliases)
    .innerJoin(companies, eq(companies.id, companyAliases.companyId));
  const grouped = new Map<number, AliasEntry>();
  for (const r of rows) {
    const g = grouped.get(r.companyId) ?? {
      companyId: r.companyId,
      name: r.name,
      symbol: r.symbol,
      aliases: [],
    };
    g.aliases.push(r.alias);
    grouped.set(r.companyId, g);
  }
  return buildAliasMatcher([...grouped.values()]);
}

export async function extractRelationshipsForCompany(
  ctx: IngestContext,
  companyId: number,
  sources: Array<{ label: string; url: string; kind: "annual_report" | "concall" }>,
  matcher: AliasMatcher,
): Promise<RelationshipExtractionResult> {
  const company = await ctx.db.query.companies.findFirst({ where: eq(companies.id, companyId) });
  if (!company) throw new Error(`company ${companyId} not found`);

  let relCount = 0;
  let concentration: number | null = null;
  let documentsProcessed = 0;

  for (const src of sources) {
    const fyEnd = periodEndFromLabel(src.label);
    const fiscalYear = src.kind === "annual_report" ? fiscalYearFromLabel(src.label) : null;
    let doc: Awaited<ReturnType<typeof ctx.docs.fetch>>["doc"];
    try {
      ({ doc } = await ctx.docs.fetch(src.url, { source: src.kind, companyId, maxAgeMs: YEAR_MS }));
    } catch (err) {
      ctx.logger.warn({ err, url: src.url }, "document fetch failed");
      continue;
    }
    if (doc.status === "parsed" && doc.parserVersion === RELATIONSHIP_EXTRACTOR_VERSION) continue;
    documentsProcessed++;

    if (src.kind === "annual_report") {
      const c = extractConcentration(doc.content);
      if (c?.revenueFromThem != null) {
        const revenueCr = toCrore(c.revenueFromThem, c.unit);
        const fy = await ctx.db.query.fundamentals.findFirst({
          where: (f, { and, eq }) =>
            and(eq(f.companyId, companyId), eq(f.periodEnd, fyEnd), eq(f.periodType, "annual")),
        });
        const total = fy?.revenue ? Number(fy.revenue) : null;
        if (total && total > 0) {
          concentration = Math.min(100, (revenueCr / total) * 100);
          await upsertSignal(ctx, companyId, fyEnd, "customer_concentration_pct", concentration, {
            customersOver10Pct: c.customersOver10Pct,
            revenueFromThemCr: revenueCr,
            totalRevenueCr: total,
            documentId: doc.id,
          });
        }
      }
    }

    for (const share of extractTopCustomerShares(doc.content).slice(0, 3)) {
      await upsertSignal(ctx, companyId, fyEnd, `top${share.topN}_customers_pct`, share.pct, {
        sentence: share.sentence,
        documentId: doc.id,
      });
    }

    const mentions = extractNamedMentions(doc.content, matcher, companyId);
    for (const m of mentions) {
      if (m.role === "unknown") continue;
      const other = await ctx.db.query.companies.findFirst({
        where: eq(companies.id, m.companyId),
      });
      if (!other) continue;
      const isCustomer = m.role === "customer";
      const res = await ctx.db
        .insert(relationships)
        .values({
          supplierCompanyId: isCustomer ? companyId : other.id,
          supplierName: isCustomer ? company.name : other.name,
          customerCompanyId: isCustomer ? other.id : companyId,
          customerName: isCustomer ? other.name : company.name,
          costBucket: "COGS",
          disclosedBy: isCustomer ? "supplier" : "customer",
          disclosureKind:
            m.pct != null ? "major_customer" : src.kind === "concall" ? "press" : "segment",
          disclosedPct: m.pct,
          fiscalYear,
          validFrom: fyEnd,
          validTo: isoDate(addYears(new Date(fyEnd), 4)),
          confidence: confidenceFor(m.pct, src.kind),
          evidence: m.sentence,
          sourceDocumentId: doc.id,
        })
        .onConflictDoNothing()
        .returning({ id: relationships.id });
      relCount += res.length;
    }
    await ctx.docs.markParsed(doc.id, RELATIONSHIP_EXTRACTOR_VERSION);
  }

  ctx.logger.info(
    { companyId, documentsProcessed, relCount, concentration },
    "relationships extracted",
  );
  return { documents: documentsProcessed, relationships: relCount, concentration };
}

async function upsertSignal(
  ctx: IngestContext,
  companyId: number,
  asOf: string,
  kind: string,
  value: number,
  inputs: Record<string, unknown>,
): Promise<void> {
  await ctx.db
    .insert(signals)
    .values({ companyId, asOf, kind, value, inputs, modelVersion: RELATIONSHIP_EXTRACTOR_VERSION })
    .onConflictDoUpdate({
      target: [signals.companyId, signals.asOf, signals.kind],
      set: {
        value: sql`excluded.value`,
        inputs: sql`excluded.inputs`,
        modelVersion: sql`excluded.model_version`,
      },
    });
}

export function fiscalYearFromLabel(label: string): number | null {
  const fy = /\b(?:FY\s?'?(\d{2,4})|(20\d{2}))\b/i.exec(label);
  if (!fy) return null;
  const n = Number(fy[1] ?? fy[2]);
  return n < 100 ? 2000 + n : n;
}

export function periodEndFromLabel(label: string): string {
  const m = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+(20\d{2})\b/i.exec(label);
  if (m) {
    const month = MONTHS.indexOf((m[1] as string).slice(0, 3).toLowerCase()) + 1;
    return isoDate(new Date(Date.UTC(Number(m[2]), month, 0)));
  }
  const fy = fiscalYearFromLabel(label);
  return fy ? `${fy}-03-31` : isoDate(new Date());
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function confidenceFor(pct: number | null, kind: "annual_report" | "concall"): number {
  const base = kind === "annual_report" ? 0.7 : 0.55;
  return pct != null ? Math.min(0.9, base + 0.15) : base - 0.15;
}
