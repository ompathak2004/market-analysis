import { UpstreamError } from "@ma/core";
import type { HttpClient } from "../http.js";
import { htmlText, type LineSnapshot, lineSnapshot } from "./html.js";

export const MYNETA_PARSER_VERSION = 1;

export type MynetaElection = "lok_sabha_2024" | "rajya_sabha";

const MYNETA = "https://myneta.info";
const ELECTION_PATH: Readonly<Record<MynetaElection, string>> = {
  lok_sabha_2024: "LokSabha2024",
  rajya_sabha: "rajsab09aff",
};

export const MYNETA_LIST_URL: Readonly<Record<MynetaElection, string>> = {
  lok_sabha_2024: `${MYNETA}/LokSabha2024/index.php?action=show_winners&sort=default`,
  rajya_sabha: `${MYNETA}/rajsab09aff/`,
};

export const mynetaCandidateUrl = (election: MynetaElection, candidateId: string) =>
  `${MYNETA}/${ELECTION_PATH[election]}/candidate.php?candidate_id=${candidateId}`;

export const mynetaCandidateKey = (election: MynetaElection, candidateId: string) =>
  `${ELECTION_PATH[election]}:${candidateId}`;

export function parseMynetaCandidateKey(
  key: string,
): { election: MynetaElection; candidateId: string } | null {
  const [path, candidateId] = key.split(":");
  const election = (Object.keys(ELECTION_PATH) as MynetaElection[]).find(
    (e) => ELECTION_PATH[e] === path,
  );
  return election && candidateId && /^\d+$/.test(candidateId) ? { election, candidateId } : null;
}

export interface MynetaListing {
  election: MynetaElection;
  candidateId: string;
  name: string;
  party: string | null;
  constituency: string | null;
  state: string | null;
  url: string;
}

export type MynetaHolder = "self" | "spouse" | "huf" | "dependent";

export interface MynetaHolding {
  holder: MynetaHolder;
  description: string;
  company: string;
  shares: number | null;
  valueRs: number | null;
}

export interface MynetaBusiness {
  holder: "self" | "spouse";
  description: string;
}

export interface MynetaCandidate {
  election: MynetaElection;
  candidateId: string;
  url: string;
  name: string;
  party: string | null;
  partyCode: string | null;
  constituency: string | null;
  state: string | null;
  age: number | null;
  selfProfession: string | null;
  spouseProfession: string | null;
  assetsRs: number | null;
  liabilitiesRs: number | null;
  holdings: MynetaHolding[];
  businesses: MynetaBusiness[];
}

const DIGITS = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ+/";
const PACKED =
  /(?:<script[^>]*>\s*)?eval\(function\(h,u,n,t,e,r\)\{[\s\S]*?\}\("([^"]*)",\s*\d+,\s*"([^"]*)",\s*(\d+),\s*(\d+),\s*\d+\)\)\s*;?(?:\s*<\/script>)?/g;

function unpack(data: string, symbols: string, offset: number, base: number): string {
  const separator = symbols[base];
  if (!separator || base < 2 || base > DIGITS.length) return "";
  const bytes: number[] = [];
  for (const chunk of data.split(separator)) {
    if (!chunk) continue;
    let value = 0;
    for (const ch of chunk) {
      const digit = symbols.indexOf(ch);
      if (digit < 0 || digit >= base) return "";
      value = value * base + digit;
    }
    bytes.push((value - offset) & 0xff);
  }
  const decoded = new TextDecoder("utf-8").decode(Uint8Array.from(bytes));
  const inner = /^\s*document\.write\('([\s\S]*)'\)\s*;?\s*$/.exec(decoded);
  return (inner?.[1] ?? decoded).replace(/\\'/g, "'");
}

export function decodeMynetaScripts(html: string): string {
  return html.replace(PACKED, (_m, data: string, symbols: string, t: string, e: string) =>
    unpack(data, symbols, Number(t), Number(e)),
  );
}

const clean = (s: string | null | undefined): string | null => {
  const out = s ? htmlText(s) : "";
  return out && !/^nil$/i.test(out) ? out : null;
};

const rupees = (s: string | null | undefined): number | null => {
  const m = s ? /([\d,]+)/.exec(s.replace(/&nbsp;/g, " ")) : null;
  const n = m?.[1] ? Number(m[1].replace(/,/g, "")) : Number.NaN;
  return Number.isFinite(n) ? n : null;
};

const cells = (row: string, tag: "td" | "th" = "td") =>
  [...row.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi"))].map(
    (m) => m[1] ?? "",
  );

const rows = (table: string) =>
  [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) => m[1] ?? "");

export function parseMynetaListing(html: string, election: MynetaElection): MynetaListing[] {
  const out: MynetaListing[] = [];
  const seen = new Set<string>();
  let columns: string[] = [];
  for (const row of rows(html)) {
    const heads = cells(row, "th");
    if (heads.length) {
      columns = heads.map((h) => (htmlText(h).toLowerCase().split(" ")[0] ?? "").trim());
      continue;
    }
    const tds = cells(row);
    const at = (name: string) => {
      const i = columns.indexOf(name);
      return i >= 0 ? tds[i] : undefined;
    };
    const candidate = at("candidate");
    const id = candidate ? /candidate_id=(\d+)/.exec(candidate)?.[1] : undefined;
    const name = clean(candidate);
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    out.push({
      election,
      candidateId: id,
      name,
      party: clean(at("party"))?.replace(/\.{3}$/, "") ?? null,
      constituency: clean(at("constituency")),
      state: clean(at("state")),
      url: mynetaCandidateUrl(election, id),
    });
  }
  return out;
}

const HOLDING =
  /^(.*?)[\s,:-]*(?:\(?\s*([\d,]+)\s*\)?\s*(?:nos?\.?\s*)?(?:equity\s+)?shares?\b.*)$/i;

function holding(holder: MynetaHolder, chunk: string): MynetaHolding | null {
  const desc = /<span class=['"]?desc['"]?>([\s\S]*?)<\/span>/i.exec(chunk);
  const description = clean(desc?.[1]);
  if (!description) return null;
  const after = chunk.slice((desc?.index ?? 0) + (desc?.[0].length ?? 0));
  const m = HOLDING.exec(description);
  const company = (m?.[1] ?? description).replace(/[\s,.-]+$/, "").trim();
  if (!company) return null;
  const shares = m?.[2] ? Number(m[2].replace(/,/g, "")) : null;
  return {
    holder,
    description,
    company,
    shares: shares && Number.isFinite(shares) ? shares : null,
    valueRs: rupees(/^\s*(?:<br\s*\/?>)?\s*([\d,]+)/i.exec(after)?.[1]),
  };
}

const HOLDERS: Readonly<Record<string, MynetaHolder>> = {
  self: "self",
  spouse: "spouse",
  huf: "huf",
  dependent1: "dependent",
  dependent2: "dependent",
  dependent3: "dependent",
};

function holdings(html: string): MynetaHolding[] {
  const table = /<table[^>]*id=['"]?movable_assets['"]?[^>]*>([\s\S]*?)<\/table>/i.exec(html)?.[1];
  if (!table) return [];
  const all = rows(table);
  const header = cells(all[0] ?? "").map((c) => htmlText(c).toLowerCase());
  const out: MynetaHolding[] = [];
  for (const row of all.slice(1)) {
    const tds = cells(row);
    if (!/shares in companies/i.test(htmlText(tds[1] ?? ""))) continue;
    tds.forEach((td, i) => {
      const holder = HOLDERS[header[i] ?? ""];
      if (!holder) return;
      for (const chunk of td.split(/<br\s*\/?>\s*<br\s*\/?>/i)) {
        const h = holding(holder, chunk);
        if (h) out.push(h);
      }
    });
  }
  return out;
}

const BUSINESS =
  /\b(director|partner|proprietor|promoter|chairman|managing|founder|business|industrialist)/i;

const firstClauses = (s: string) => s.split(",").slice(0, 2).join(",").trim();

function businesses(self: string | null, spouse: string | null): MynetaBusiness[] {
  const out: MynetaBusiness[] = [];
  if (self && BUSINESS.test(self)) out.push({ holder: "self", description: firstClauses(self) });
  if (spouse && BUSINESS.test(spouse))
    out.push({ holder: "spouse", description: firstClauses(spouse) });
  return out;
}

const field = (html: string, label: string) =>
  clean(
    new RegExp(`<b>\\s*${label}\\s*<\\/b>([\\s\\S]*?)(?:<br\\s*\\/?>|<\\/div>|<\\/p>)`, "i").exec(
      html,
    )?.[1],
  );

export function parseMynetaCandidate(
  raw: string,
  election: MynetaElection,
  candidateId: string,
): MynetaCandidate {
  const html = decodeMynetaScripts(raw);
  const title = clean(/<title>([\s\S]*?)<\/title>/i.exec(html)?.[1]) ?? "";
  const heading = /<h2>([\s\S]*?)<\/h2>/i.exec(html)?.[1]?.replace(/<font[\s\S]*?<\/font>/gi, "");
  const name = clean(heading) ?? clean(/^(.*?)\(/.exec(title)?.[1]);
  if (!name) throw new UpstreamError("myneta", "candidate page without a name", { candidateId });
  const partyFull = /\(([^()]+)\(([^()]+)\)\):/.exec(title);
  const place = clean(/<h5>([\s\S]*?)<\/h5>/i.exec(html)?.[1]);
  const placeParts = place ? /^(.*?)\s*\(([^()]+)\)$/.exec(place) : null;
  const body = htmlText(html);
  const selfProfession = field(html, "Self Profession:");
  const spouseProfession = field(html, "Spouse Profession:");
  const age = Number(field(html, "Age:"));
  return {
    election,
    candidateId,
    url: mynetaCandidateUrl(election, candidateId),
    name,
    party: partyFull?.[1]?.trim() ?? null,
    partyCode: field(html, "Party:") ?? partyFull?.[2]?.trim() ?? null,
    constituency: placeParts?.[1]?.trim() || null,
    state: placeParts?.[2]?.trim() ?? place,
    age: Number.isFinite(age) && age > 0 ? age : null,
    selfProfession,
    spouseProfession,
    assetsRs: rupees(/Assets:\s*Rs\s*([\d,]+)/i.exec(body)?.[1]),
    liabilitiesRs: rupees(/Liabilities:\s*Rs\s*([\d,]+)/i.exec(body)?.[1]),
    holdings: holdings(html),
    businesses: businesses(selfProfession, spouseProfession),
  };
}

export const holdingKey = (h: MynetaHolding) =>
  `share:${h.holder}:${h.description.toLowerCase().replace(/\s+/g, " ")}`;
export const businessKey = (b: MynetaBusiness) => `business:${b.holder}`;

export function mynetaSnapshot(c: MynetaCandidate): LineSnapshot {
  const { holdings: hs, businesses: bs, ...profile } = c;
  const items: { key: string; row: Record<string, unknown> }[] = [
    { key: "profile", row: profile },
    ...hs.map((h) => ({ key: holdingKey(h), row: { ...h } })),
    ...bs.map((b) => ({ key: businessKey(b), row: { ...b } })),
  ];
  return lineSnapshot(
    { source: "myneta", parserVersion: MYNETA_PARSER_VERSION, election: c.election, url: c.url },
    items,
    (r) => r.key,
    (r) => r.row,
  );
}

export class MynetaSource {
  constructor(private readonly http: HttpClient) {}

  private async page(url: string, signal?: AbortSignal): Promise<string> {
    const res = await this.http.get(url, {
      headers: { accept: "text/html" },
      timeoutMs: 60_000,
      ...(signal ? { signal } : {}),
    });
    if (res.status !== 200) throw new UpstreamError("myneta", `status ${res.status}`, { url });
    return res.text();
  }

  async listing(election: MynetaElection, signal?: AbortSignal): Promise<MynetaListing[]> {
    const out = parseMynetaListing(await this.page(MYNETA_LIST_URL[election], signal), election);
    if (!out.length) throw new UpstreamError("myneta", "empty listing", { election });
    return out;
  }

  async candidate(
    election: MynetaElection,
    candidateId: string,
    signal?: AbortSignal,
  ): Promise<MynetaCandidate> {
    return parseMynetaCandidate(
      await this.page(mynetaCandidateUrl(election, candidateId), signal),
      election,
      candidateId,
    );
  }
}
