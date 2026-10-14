import { UpstreamError } from "@ma/core";
import { pdfToText } from "../documents.js";
import type { HttpClient } from "../http.js";
import { istTimestamp, monthNumber, type PolicyDocument } from "./policy-doc.js";

export const EGAZETTE_PARSER_VERSION = 1;
export const EGAZETTE_HOME_URL = "https://egazette.gov.in/";
export const EGAZETTE_PDF_PAGES = 4;

const ORDINAL_DATE =
  /New\s+Delhi,?\s+the\s+(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9}),?\s+(\d{4})/i;
const PLAIN_DATE = /\b([A-Z]{3,9})\s+(\d{1,2}),\s*(\d{4})\b/;
const NUMBER = /\b(G\.\s?S\.\s?R\.|S\.\s?O\.)\s*(\d{1,5})\s*\(\s*E\s*\)/i;
const MINISTRY =
  /\bMINISTRY\s+OF\s+([A-Z][A-Z ,&-]{2,80}?)(?=\s*(?:\(|NOTIFICATION|ORDER|RESOLUTION|\n|$))/;
const SHORT_TITLE = /(?:may|shall)\s+be\s+called\s+the\s+([^.;]{5,200})[.;]/i;
const KIND = /\b(NOTIFICATION|ORDER|RESOLUTION|CORRIGENDUM)\b/;

const titleCase = (s: string) =>
  s
    .toLowerCase()
    .replace(/\b([a-z])/g, (c) => c.toUpperCase())
    .replace(/\b(And|Of|The|For)\b/g, (w) => w.toLowerCase())
    .trim();

function gazetteDate(text: string): Date | null {
  const ordinal = ORDINAL_DATE.exec(text);
  if (ordinal) {
    const month = monthNumber(ordinal[2] ?? "");
    if (month) return istTimestamp(Number(ordinal[3]), month, Number(ordinal[1]));
  }
  const plain = PLAIN_DATE.exec(text);
  const month = plain ? monthNumber(plain[1] ?? "") : null;
  return plain && month ? istTimestamp(Number(plain[3]), month, Number(plain[2])) : null;
}

export function parseGazetteNotification(text: string, url: string): PolicyDocument | null {
  const flat = text.replace(/[ \t]+/g, " ");
  const number = NUMBER.exec(flat);
  const publishedAt = gazetteDate(flat);
  if (!number || !publishedAt) return null;
  const series = (number[1] ?? "").replace(/[\s.]/g, "").toUpperCase();
  const ministryRaw = MINISTRY.exec(flat)?.[1]?.replace(/\s+/g, " ").trim();
  const ministry = ministryRaw ? `Ministry of ${titleCase(ministryRaw)}` : null;
  const kind = KIND.exec(flat)?.[1] ?? "NOTIFICATION";
  const short = SHORT_TITLE.exec(flat)?.[1]?.replace(/\s+/g, " ").trim();
  const id = `${series} ${number[2]}(E)`;
  const start = number.index;
  return {
    source: "egazette",
    externalId: `${publishedAt.getFullYear()}:${id}`,
    title: short ?? `${ministry ?? "Government of India"} ${titleCase(kind)} ${id}`,
    ministry,
    stage: titleCase(kind),
    publishedAt,
    url,
    text: flat.slice(start).trim(),
  };
}

export class EgazetteSource {
  constructor(private readonly http: HttpClient) {}

  async reachable(signal?: AbortSignal): Promise<boolean> {
    try {
      const res = await this.http.get(EGAZETTE_HOME_URL, {
        timeoutMs: 30_000,
        retries: 0,
        ...(signal ? { signal } : {}),
      });
      return res.status === 200;
    } catch (err) {
      if (signal?.aborted) throw err;
      return false;
    }
  }

  async notification(url: string, signal?: AbortSignal): Promise<PolicyDocument> {
    const res = await this.http.get(url, { timeoutMs: 120_000, ...(signal ? { signal } : {}) });
    if (res.status !== 200) throw new UpstreamError("egazette", `status ${res.status}`, { url });
    const { text } = await pdfToText(res.body, EGAZETTE_PDF_PAGES);
    const doc = parseGazetteNotification(text, url);
    if (!doc) throw new UpstreamError("egazette", "no notification number or date", { url });
    return doc;
  }
}
