import { UpstreamError } from "@ma/core";
import type { HttpClient } from "../http.js";
import { type LineSnapshot, lineSnapshot } from "./html.js";

export const PARLIAMENT_PARSER_VERSION = 1;

export type ParliamentHouse = "lok_sabha" | "rajya_sabha";
export const LOK_SABHA_TERM = 18;

const SANSAD = "https://sansad.in";
export const LOK_SABHA_MEMBERS_URL = `${SANSAD}/api_ls/member?lang=en&loksabha=${LOK_SABHA_TERM}&sitting=1&page=1&size=600`;
export const RAJYA_SABHA_MEMBERS_URL = `${SANSAD}/api_rs/member/sitting-members?locale=en&page=1&size=300&mpFlag=1`;
export const COUNCIL_OF_MINISTERS_URL = `${SANSAD}/api_ls/member/getInCouncilOfMinisters?locale=en`;
export const PARLIAMENT_PAGE_URL: Readonly<Record<ParliamentHouse, string>> = {
  lok_sabha: `${SANSAD}/ls/members`,
  rajya_sabha: `${SANSAD}/rs/members`,
};

export type MinisterRank = "prime_minister" | "cabinet_minister" | "minister_of_state" | "minister";

export interface ParliamentMember {
  house: ParliamentHouse;
  memberId: string;
  name: string;
  party: string | null;
  partyCode: string | null;
  constituency: string | null;
  state: string | null;
  birthYear: number | null;
  fromDate: string | null;
  toDate: string | null;
}

export interface Minister {
  house: ParliamentHouse;
  memberId: string;
  name: string;
  rank: MinisterRank;
  position: string;
}

export interface ParliamentDirectory {
  members: ParliamentMember[];
  ministers: Minister[];
}

const text = (v: unknown): string | null => {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v !== "string") return null;
  const s = v.replace(/\s+/g, " ").trim();
  return s ? s : null;
};

const HONORIFIC =
  /^(?:shri|smt|sushri|kumari|dr|prof|adv|col|capt|maj|gen|thiru|selvi|km|ms|mr|mrs|sri)\.?\s+/i;

export function stripHonorific(name: string): string {
  let out = name.replace(/\s+/g, " ").trim();
  while (HONORIFIC.test(out)) out = out.replace(HONORIFIC, "");
  return out;
}

export function displayName(raw: string): string {
  const [last, first] = raw.split(",", 2).map((s) => stripHonorific(s));
  return first ? `${first} ${last}`.trim() : stripHonorific(raw);
}

const dmyDay = (raw: unknown): string | null => {
  const s = text(raw);
  const m = s ? /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s) : null;
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
};

const birthYear = (raw: unknown): number | null => {
  const s = text(raw);
  const m = s ? /(\d{4})/.exec(s) : null;
  return m ? Number(m[1]) : null;
};

function parseJson(json: string, what: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    throw new UpstreamError("sansad", `non-JSON ${what} response`);
  }
}

function records(parsed: unknown, field: string, what: string): Record<string, unknown>[] {
  const rows = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)[field]
      : null;
  if (!Array.isArray(rows)) throw new UpstreamError("sansad", `unexpected ${what} shape`);
  return rows.filter((r): r is Record<string, unknown> => !!r && typeof r === "object");
}

export function parseLokSabhaMembers(json: string): ParliamentMember[] {
  return records(parseJson(json, "lok sabha"), "membersDtoList", "lok sabha").flatMap((r) => {
    const memberId = text(r.mpsno);
    const name =
      text(r.mpFirstLastName) ?? text(`${text(r.firstName) ?? ""} ${text(r.lastName) ?? ""}`);
    if (!memberId || !name || text(r.status)?.toLowerCase() !== "sitting") return [];
    return [
      {
        house: "lok_sabha" as const,
        memberId,
        name: stripHonorific(name),
        party: text(r.partyFname),
        partyCode: text(r.partySname),
        constituency: text(r.constName),
        state: text(r.stateName),
        birthYear: birthYear(r.dob),
        fromDate: null,
        toDate: null,
      },
    ];
  });
}

export function parseRajyaSabhaMembers(json: string): ParliamentMember[] {
  return records(parseJson(json, "rajya sabha"), "records", "rajya sabha").flatMap((r) => {
    const memberId = text(r.mpsno);
    const parts = [text(r.firstName), text(r.lastName)].filter((s): s is string => !!s);
    const raw = parts.length ? parts.join(" ") : text(r.name);
    if (!memberId || !raw || Number(r.mpFlag ?? 1) !== 1) return [];
    return [
      {
        house: "rajya_sabha" as const,
        memberId,
        name: parts.length ? stripHonorific(raw) : displayName(raw),
        party: text(r.party),
        partyCode: text(r.partyCode),
        constituency: null,
        state: text(r.state),
        birthYear: birthYear(r.dob),
        fromDate: dmyDay(r.notificationDate),
        toDate: dmyDay(r.expirationDate),
      },
    ];
  });
}

export function ministerRank(position: string): MinisterRank {
  const p = position.toLowerCase();
  if (p.includes("prime minister")) return "prime_minister";
  if (p.includes("cabinet")) return "cabinet_minister";
  if (p.includes("state")) return "minister_of_state";
  return "minister";
}

export function parseCouncilOfMinisters(json: string): Minister[] {
  return records(parseJson(json, "council of ministers"), "data", "council of ministers").flatMap(
    (r) => {
      const memberId = text(r.mpsno);
      const name = text(r.fullName);
      const position = text(r.position);
      const house = text(r.house)?.toUpperCase();
      if (!memberId || !name || !position || (house !== "LS" && house !== "RS")) return [];
      return [
        {
          house: house === "LS" ? ("lok_sabha" as const) : ("rajya_sabha" as const),
          memberId,
          name: stripHonorific(name),
          rank: ministerRank(position),
          position,
        },
      ];
    },
  );
}

export const memberKey = (m: { house: ParliamentHouse; memberId: string }) =>
  `${m.house === "lok_sabha" ? "ls" : "rs"}:${m.memberId}`;

export const ministerKey = (m: Minister) => `minister:${memberKey(m)}`;

export function parliamentSnapshot(dir: ParliamentDirectory, house: ParliamentHouse): LineSnapshot {
  const rows: { key: string; row: ParliamentMember | Minister }[] = [
    ...dir.members.filter((m) => m.house === house).map((m) => ({ key: memberKey(m), row: m })),
    ...dir.ministers.filter((m) => m.house === house).map((m) => ({ key: ministerKey(m), row: m })),
  ];
  return lineSnapshot(
    {
      source: "parliament",
      parserVersion: PARLIAMENT_PARSER_VERSION,
      house,
      lokSabha: LOK_SABHA_TERM,
      urls: [
        house === "lok_sabha" ? LOK_SABHA_MEMBERS_URL : RAJYA_SABHA_MEMBERS_URL,
        COUNCIL_OF_MINISTERS_URL,
      ],
    },
    rows,
    (r) => r.key,
    (r) => ({ ...r.row }),
  );
}

export class ParliamentSource {
  constructor(private readonly http: HttpClient) {}

  private async json(url: string, signal?: AbortSignal): Promise<string> {
    const res = await this.http.get(url, {
      headers: { accept: "application/json" },
      timeoutMs: 60_000,
      ...(signal ? { signal } : {}),
    });
    if (res.status !== 200) throw new UpstreamError("sansad", `status ${res.status}`, { url });
    return res.text();
  }

  async directory(signal?: AbortSignal): Promise<ParliamentDirectory> {
    const lok = parseLokSabhaMembers(await this.json(LOK_SABHA_MEMBERS_URL, signal));
    const rajya = parseRajyaSabhaMembers(await this.json(RAJYA_SABHA_MEMBERS_URL, signal));
    const ministers = parseCouncilOfMinisters(await this.json(COUNCIL_OF_MINISTERS_URL, signal));
    if (!lok.length || !rajya.length) throw new UpstreamError("sansad", "empty member directory");
    return { members: [...lok, ...rajya], ministers };
  }
}
