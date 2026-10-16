import {
  and,
  companyOperatingSites,
  documentRevisions,
  documents,
  eq,
  fencedTransaction,
} from "@ma/db";
import { type IngestContext, stateCodeFor } from "@ma/ingest";
import { spanFor } from "./store.js";

export interface OperatingSiteInput {
  name: string;
  stateCode: string;
  stateName: string;
  quote: string;
}

export function groundOperatingSites(text: string, sites: readonly OperatingSiteInput[]) {
  const names = new Set<string>();
  return sites.map((site) => {
    if (names.has(site.name)) throw new Error("Duplicate operating site");
    names.add(site.name);
    const start = text.indexOf(site.quote);
    const quoted = site.quote.toLowerCase();
    const escapePattern = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const association = new RegExp(
      `${escapePattern(site.name)}\\s*(?:in|,|[-–])\\s*${escapePattern(site.stateName)}`,
      "i",
    );
    if (
      stateCodeFor(site.stateName) !== site.stateCode ||
      start < 0 ||
      !quoted.includes(site.name.toLowerCase()) ||
      !association.test(site.quote)
    ) {
      throw new Error(`Operating site ${site.name} is not grounded in the document`);
    }
    return { ...site, start, end: start + site.quote.length };
  });
}

export async function syncOperatingSites(
  ctx: IngestContext,
  input: {
    companyId: number;
    documentId: number;
    sites: OperatingSiteInput[];
  },
  signal?: AbortSignal,
) {
  const doc = await ctx.db.query.documents.findFirst({
    where: and(eq(documents.id, input.documentId), eq(documents.companyId, input.companyId)),
  });
  if (!doc?.currentRevisionId)
    throw new Error(
      "Operating-site document must belong to this company and have an immutable revision",
    );
  const revision = await ctx.db.query.documentRevisions.findFirst({
    where: eq(documentRevisions.id, doc.currentRevisionId),
  });
  if (!revision) throw new Error("Operating-site revision unavailable");
  const text = await ctx.docs.text(revision);
  if (!text) throw new Error("Operating-site document text unavailable");
  const sites = groundOperatingSites(text, input.sites);
  return fencedTransaction(
    ctx.db,
    async (tx) => {
      await tx
        .delete(companyOperatingSites)
        .where(
          and(
            eq(companyOperatingSites.companyId, input.companyId),
            eq(companyOperatingSites.documentId, doc.id),
          ),
        );
      for (const site of sites) {
        const evidenceSpanId = await spanFor(tx, doc.currentRevisionId as number, text, site, {
          source: "operating_site",
          stateCode: site.stateCode,
        });
        if (!evidenceSpanId) throw new Error("Operating-site evidence unavailable");
        await tx.insert(companyOperatingSites).values({
          companyId: input.companyId,
          documentId: doc.id,
          name: site.name,
          stateCode: site.stateCode,
          evidenceSpanId,
          observedOn: (doc.publishedAt ?? doc.fetchedAt).toISOString().slice(0, 10),
        });
      }
      return { sites: sites.length };
    },
    signal,
  );
}
