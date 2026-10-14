export type SourceKind = "structured_primary" | "primary" | "news" | "inference";

export type IdentityBasis = "din" | "member_id" | "name_corroborated" | "name_only" | "ambiguous";

export type EdgeStatus = "pending" | "confirmed";

export type PersonIdentifierScheme =
  | "lok_sabha_member"
  | "rajya_sabha_member"
  | "myneta_candidate"
  | "assembly_member";

export interface PersonIdentifier {
  scheme: PersonIdentifierScheme;
  value: string;
}

export interface PersonCandidate {
  id: number;
  din: string | null;
  normalizedName: string;
  aliases?: readonly string[];
  identifiers?: readonly PersonIdentifier[];
}

export interface PersonClaim {
  name: string;
  din?: string | null;
  memberId?: PersonIdentifier | null;
  source: SourceKind;
  independentDocuments?: number;
}

export interface PersonResolution {
  personId: number | null;
  create: boolean;
  basis: IdentityBasis;
  confidence: number;
  identifier: boolean;
  candidates: number[];
}

export interface EdgeClaim {
  confidence: number;
  source: SourceKind;
  identifier: boolean;
}

export type RptRelationshipClass =
  | "holding"
  | "group"
  | "subsidiary"
  | "associate_jv"
  | "kmp"
  | "employee_benefit"
  | "other";
