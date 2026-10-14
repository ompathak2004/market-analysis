import { namesCompatible, normalizeDin, normalizePersonName } from "./normalize.js";
import type {
  IdentityBasis,
  PersonCandidate,
  PersonClaim,
  PersonResolution,
  SourceKind,
} from "./types.js";

export const INFLUENCE_RESOLVER_VERSION = 1;

export const CONFIDENCE = {
  structuredIdentifier: 0.98,
  twoPrimaryDocuments: 0.95,
  singleDocumentName: 0.8,
  newsOrInference: 0.6,
  ambiguous: 0.4,
} as const;

const PRIMARY: ReadonlySet<SourceKind> = new Set(["structured_primary", "primary"]);

export function confidenceFor(
  basis: IdentityBasis,
  source: SourceKind,
  independentDocuments = 1,
): number {
  if (!PRIMARY.has(source)) {
    return basis === "ambiguous" ? CONFIDENCE.ambiguous : CONFIDENCE.newsOrInference;
  }
  switch (basis) {
    case "din":
    case "member_id":
      return source === "structured_primary"
        ? CONFIDENCE.structuredIdentifier
        : CONFIDENCE.twoPrimaryDocuments;
    case "name_corroborated":
      return independentDocuments >= 2
        ? CONFIDENCE.twoPrimaryDocuments
        : CONFIDENCE.singleDocumentName;
    case "name_only":
      return CONFIDENCE.singleDocumentName;
    case "ambiguous":
      return CONFIDENCE.ambiguous;
  }
}

function matchesName(candidate: PersonCandidate, name: string): boolean {
  if (namesCompatible(candidate.normalizedName, name)) return true;
  return (candidate.aliases ?? []).some((alias) => namesCompatible(alias, name));
}

function result(
  personId: number | null,
  basis: IdentityBasis,
  claim: PersonClaim,
  candidates: number[] = [],
): PersonResolution {
  const identifier = basis === "din" || basis === "member_id";
  return {
    personId,
    create: personId === null && basis !== "ambiguous",
    basis,
    confidence: confidenceFor(basis, claim.source, claim.independentDocuments ?? 1),
    identifier,
    candidates,
  };
}

export function resolvePerson(
  claim: PersonClaim,
  candidates: readonly PersonCandidate[],
): PersonResolution {
  const din = normalizeDin(claim.din);
  if (din) {
    const hit = candidates.find((c) => c.din === din);
    return result(hit?.id ?? null, "din", claim);
  }

  const member = claim.memberId;
  if (member) {
    const hit = candidates.find((c) =>
      (c.identifiers ?? []).some((i) => i.scheme === member.scheme && i.value === member.value),
    );
    return result(hit?.id ?? null, "member_id", claim);
  }

  const name = normalizePersonName(claim.name);
  const matches = candidates.filter((c) => matchesName(c, name));
  const corroborated = (claim.independentDocuments ?? 1) >= 2;
  const basis: IdentityBasis = corroborated ? "name_corroborated" : "name_only";
  if (matches.length === 0) return result(null, basis, claim);
  if (matches.length === 1) return result((matches[0] as PersonCandidate).id, basis, claim);
  const exact = matches.filter((c) => c.normalizedName === name);
  if (exact.length === 1) return result((exact[0] as PersonCandidate).id, basis, claim);
  return result(
    null,
    "ambiguous",
    claim,
    matches.map((c) => c.id),
  );
}
