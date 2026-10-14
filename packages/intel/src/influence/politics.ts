import type {
  Minister,
  MinisterRank,
  MynetaElection,
  MynetaHolding,
  MynetaListing,
  ParliamentDirectory,
  ParliamentHouse,
  ParliamentMember,
} from "@ma/ingest";
import { memberKey, ministerKey } from "@ma/ingest";
import { namesCompatible, nameTokens, normalizePersonName } from "./normalize.js";
import type { PersonIdentifier } from "./types.js";

export const POLITICS_RULE_VERSION = 1;

export type PoliticalOffice = "mp_lok_sabha" | "mp_rajya_sabha" | "minister";

export const INSTITUTION: Readonly<Record<PoliticalOffice, string>> = {
  mp_lok_sabha: "Lok Sabha",
  mp_rajya_sabha: "Rajya Sabha",
  minister: "Union Council of Ministers",
};

const RANK_LABEL: Readonly<Record<MinisterRank, string>> = {
  prime_minister: "Prime Minister",
  cabinet_minister: "Cabinet Minister",
  minister_of_state: "Minister of State",
  minister: "Minister",
};

export interface OfficeClaim {
  key: string;
  spanKey: string;
  member: ParliamentMember;
  identifier: PersonIdentifier;
  office: PoliticalOffice;
  label: string;
  fromDate: string | null;
  toDate: string | null;
}

export const memberIdentifier = (m: {
  house: ParliamentHouse;
  memberId: string;
}): PersonIdentifier => ({
  scheme: m.house === "lok_sabha" ? "lok_sabha_member" : "rajya_sabha_member",
  value: m.memberId,
});

function memberLabel(m: ParliamentMember): string {
  const house = m.house === "lok_sabha" ? "MP, Lok Sabha" : "MP, Rajya Sabha";
  const seat = m.constituency ?? m.state;
  return seat ? `${house} (${seat})` : house;
}

export function officeClaims(dir: ParliamentDirectory): OfficeClaim[] {
  const byKey = new Map(dir.members.map((m) => [memberKey(m), m]));
  const out: OfficeClaim[] = dir.members.map((m) => ({
    key: `parliament:${memberKey(m)}`,
    spanKey: memberKey(m),
    member: m,
    identifier: memberIdentifier(m),
    office: m.house === "lok_sabha" ? "mp_lok_sabha" : "mp_rajya_sabha",
    label: memberLabel(m),
    fromDate: m.fromDate,
    toDate: m.toDate,
  }));
  for (const minister of dir.ministers) {
    const member = byKey.get(memberKey(minister));
    if (!member) continue;
    out.push(ministerClaim(minister, member));
  }
  return out;
}

function ministerClaim(minister: Minister, member: ParliamentMember): OfficeClaim {
  const position = minister.position.trim();
  const rank = RANK_LABEL[minister.rank];
  return {
    key: `parliament:${ministerKey(minister)}`,
    spanKey: ministerKey(minister),
    member,
    identifier: memberIdentifier(member),
    office: "minister",
    label:
      position && position.toLowerCase() !== rank.toLowerCase() ? `${rank}, ${position}` : rank,
    fromDate: null,
    toDate: null,
  };
}

export function constituencyKey(raw: string | null | undefined): string {
  return (raw ?? "")
    .toLowerCase()
    .replace(/\((?:sc|st)\)/g, " ")
    .replace(/[^a-z]/g, "");
}

export const mynetaElectionFor = (house: ParliamentHouse): MynetaElection =>
  house === "lok_sabha" ? "lok_sabha_2024" : "rajya_sabha";

export function matchMynetaListing(
  member: Pick<ParliamentMember, "house" | "name" | "constituency" | "state">,
  listings: readonly MynetaListing[],
): MynetaListing | null {
  const election = mynetaElectionFor(member.house);
  const name = normalizePersonName(member.name);
  const pool = listings.filter((l) => l.election === election);
  const hits =
    member.house === "lok_sabha"
      ? pool.filter(
          (l) =>
            constituencyKey(l.constituency) === constituencyKey(member.constituency) &&
            constituencyKey(l.constituency) !== "",
        )
      : pool.filter(
          (l) =>
            constituencyKey(l.state) === constituencyKey(member.state) &&
            namesCompatible(normalizePersonName(l.name), name),
        );
  if (hits.length !== 1) return null;
  const [hit] = hits;
  return hit && sharesNameToken(hit.name, name) ? hit : null;
}

function sharesNameToken(a: string, b: string): boolean {
  if (namesCompatible(normalizePersonName(a), b)) return true;
  const tokens = new Set(nameTokens(b).filter((t) => t.length >= 4));
  return nameTokens(a).some((t) => tokens.has(t));
}

export type AffidavitKind = "shareholding" | "family_interest" | "business_interest";

export function holdingKind(h: Pick<MynetaHolding, "holder">): AffidavitKind {
  return h.holder === "self" ? "shareholding" : "family_interest";
}

export const RUPEES_PER_CRORE = 10_000_000;

export function rupeesToCrore(rs: number | null): string | null {
  return rs == null ? null : (rs / RUPEES_PER_CRORE).toFixed(2);
}
