import { UpstreamError } from "@ma/core";
import { htmlText } from "./html.js";
import { stripHonorific } from "./parliament.js";

export const STATE_GOVERNMENT_PARSER_VERSION = 1;
export const CHIEF_MINISTERS_URL =
  "https://www.india.gov.in/directory/whos-who/chief-ministers-of-states-and-union-territories";

const STATE_NAMES: Readonly<Record<string, string>> = {
  "Andaman and Nicobar Islands": "IN-AN",
  Chandigarh: "IN-CH",
  "Dadra and Nagar Haveli and Daman and Diu": "IN-DH",
  Ladakh: "IN-LA",
  Lakshadweep: "IN-LD",
  "Andhra Pradesh": "IN-AP",
  "Arunachal Pradesh": "IN-AR",
  Assam: "IN-AS",
  Bihar: "IN-BR",
  Chhattisgarh: "IN-CG",
  "Delhi (NCT)": "IN-DL",
  Delhi: "IN-DL",
  Goa: "IN-GA",
  Gujarat: "IN-GJ",
  Haryana: "IN-HR",
  "Himachal Pradesh": "IN-HP",
  "Jammu and Kashmir": "IN-JK",
  Jharkhand: "IN-JH",
  Karnataka: "IN-KA",
  Kerala: "IN-KL",
  "Madhya Pradesh": "IN-MP",
  Maharashtra: "IN-MH",
  Manipur: "IN-MN",
  Meghalaya: "IN-ML",
  Mizoram: "IN-MZ",
  Nagaland: "IN-NL",
  Odisha: "IN-OD",
  Puducherry: "IN-PY",
  Punjab: "IN-PB",
  Rajasthan: "IN-RJ",
  Sikkim: "IN-SK",
  "Tamil Nadu": "IN-TN",
  Telangana: "IN-TS",
  Tripura: "IN-TR",
  "Uttar Pradesh": "IN-UP",
  Uttarakhand: "IN-UK",
  "West Bengal": "IN-WB",
};

export const stateCodeFor = (name: string): string | null => STATE_NAMES[name] ?? null;

export interface StateHead {
  stateCode: string;
  stateName: string;
  headName: string;
  start: number;
  end: number;
}

export function parseStateHeads(markdown: string): StateHead[] {
  const rows = new Map<string, StateHead>();
  const matches = /<h5\b/i.test(markdown)
    ? markdown.matchAll(/<h5\b[^>]*>([\s\S]*?)<\/h5>\s*<p\b[^>]*>([\s\S]*?)<\/p>/gi)
    : markdown.matchAll(/^#{3,6}\s+([^\n]+)\n\s*\n([^\n]+)$/gm);
  for (const match of matches) {
    const stateName = htmlText(match[2] ?? "");
    const stateCode = STATE_NAMES[stateName];
    const rawName = htmlText(match[1] ?? "");
    const headName = stripHonorific(rawName);
    if (!stateCode || headName.length < 3 || /vacant|president.?s rule/i.test(headName)) continue;
    if (rows.has(stateCode))
      throw new UpstreamError("india.gov.in", `duplicate chief minister for ${stateName}`);
    rows.set(stateCode, {
      stateCode,
      stateName,
      headName,
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  if (rows.size < 20)
    throw new UpstreamError(
      "india.gov.in",
      "Incomplete chief-minister directory; keeping previous observations",
    );
  return [...rows.values()];
}

export function stateDirectoryReviewedOn(markdown: string): string | null {
  const normalized = /Source reviewed on: (\d{4}-\d{2}-\d{2})/.exec(markdown);
  if (normalized?.[1]) return normalized[1];
  const text = htmlText(markdown);
  const tail = text.slice(text.lastIndexOf("Last reviewed and updated on"));
  const match =
    /\b(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(20\d{2})\b/.exec(
      tail,
    );
  if (!match) return null;
  const date = new Date(`${match[2]} ${match[1]}, ${match[3]} 00:00:00 UTC`);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : null;
}

export function stateDirectoryText(content: string): string {
  const rows = parseStateHeads(content);
  const reviewedOn = stateDirectoryReviewedOn(content);
  return [
    "# Chief Ministers",
    ...rows.map((row) => `##### ${row.headName}\n\n${row.stateName}`),
    ...(reviewedOn ? [`Source reviewed on: ${reviewedOn}`] : []),
  ].join("\n\n");
}
