import { UpstreamError } from "@ma/core";
import type { HttpClient } from "../http.js";
import { decodeHtml, htmlText } from "./html.js";
import { istTimestamp, monthNumber, type PolicyDocument } from "./policy-doc.js";

export const PIB_PARSER_VERSION = 1;

export const PIB_RSS_URL = "https://www.pib.gov.in/RssMain.aspx?ModId=6&Lang=1&Regid=3&reg=3";
export const pibReleaseUrl = (prid: string) =>
  `https://www.pib.gov.in/PressReleaseIframePage.aspx?PRID=${prid}&reg=3&lang=1`;

export interface PibItem {
  prid: string;
  title: string;
}

export function parsePibRss(xml: string): PibItem[] {
  const out: PibItem[] = [];
  const seen = new Set<string>();
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const body = m[1] ?? "";
    const link = /<link>([\s\S]*?)<\/link>/i.exec(body)?.[1] ?? "";
    const prid = /PRID=(\d+)/i.exec(link)?.[1];
    const title = htmlText(decodeHtml(/<title>([\s\S]*?)<\/title>/i.exec(body)?.[1] ?? ""));
    if (!prid || !title || seen.has(prid)) continue;
    seen.add(prid);
    out.push({ prid, title });
  }
  return out;
}

const byId = (html: string, id: string, tag = "div") =>
  new RegExp(`<${tag}[^>]*id="${id}"[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i").exec(html)?.[1];

export function parsePibPosted(raw: string): Date | null {
  const m = /(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})(?:\s+(\d{1,2}):(\d{2})\s*([AP]M))?/i.exec(raw);
  if (!m) return null;
  const month = monthNumber(m[2] ?? "");
  if (!month) return null;
  let hour = Number(m[4] ?? 0) % 12;
  if ((m[6] ?? "").toUpperCase() === "PM") hour += 12;
  return istTimestamp(Number(m[3]), month, Number(m[1]), hour, Number(m[5] ?? 0));
}

export function parsePibRelease(html: string, prid: string): PolicyDocument {
  const title = htmlText(byId(html, "Titleh2", "h1") ?? "");
  const posted = parsePibPosted(htmlText(byId(html, "PrDateTime") ?? ""));
  if (!title || !posted) throw new UpstreamError("pib", "release without title or date", { prid });
  const start = html.search(/<div[^>]*id="PrDateTime"/i);
  const end = html.search(/<span[^>]*id="ReleaseId"/i);
  const body = start >= 0 ? html.slice(start, end > start ? end : undefined) : "";
  const paragraphs = [...body.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((p) => htmlText(p[1] ?? ""))
    .filter((p) => p && p !== "***");
  return {
    source: "pib",
    externalId: prid,
    title,
    ministry: htmlText(byId(html, "MinistryName") ?? "") || null,
    stage: "release",
    publishedAt: posted,
    url: pibReleaseUrl(prid),
    text: paragraphs.join("\n"),
  };
}

export class PibSource {
  constructor(private readonly http: HttpClient) {}

  private async page(url: string, signal?: AbortSignal): Promise<string> {
    const res = await this.http.get(url, { timeoutMs: 60_000, ...(signal ? { signal } : {}) });
    if (res.status !== 200) throw new UpstreamError("pib", `status ${res.status}`, { url });
    return res.text();
  }

  async recent(signal?: AbortSignal): Promise<PibItem[]> {
    return parsePibRss(await this.page(PIB_RSS_URL, signal));
  }

  async release(prid: string, signal?: AbortSignal): Promise<PolicyDocument> {
    return parsePibRelease(await this.page(pibReleaseUrl(prid), signal), prid);
  }
}
