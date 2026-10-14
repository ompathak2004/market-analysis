import { UpstreamError } from "@ma/core";
import type { HttpClient } from "../http.js";
import { htmlText } from "./html.js";
import { istTimestamp, monthNumber, type PolicyDocument } from "./policy-doc.js";

export const PRS_PARSER_VERSION = 1;

const PRS = "https://prsindia.org";
export const PRS_BILLTRACK_URL = `${PRS}/billtrack`;
export const prsBillUrl = (slug: string) => `${PRS}/billtrack/${slug}`;

export interface PrsListing {
  slug: string;
  title: string;
  status: string | null;
  url: string;
}

export interface PrsStage {
  status: string;
  house: string | null;
  date: Date | null;
}

export function parsePrsBillList(html: string): PrsListing[] {
  const out: PrsListing[] = [];
  const seen = new Set<string>();
  for (const block of html.split(/<div class="views-row[^"]*">/i).slice(1)) {
    const link = /<h3[^>]*>\s*<a\s+href="\/billtrack\/([^"#?]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    const slug = link?.[1]?.trim();
    const title = htmlText(link?.[2] ?? "");
    if (!slug || !title || slug.startsWith("prs-products") || seen.has(slug)) continue;
    seen.add(slug);
    const status = htmlText(
      /<span\s+class="status-[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(block)?.[1] ?? "",
    );
    out.push({ slug, title, status: status || null, url: prsBillUrl(slug) });
  }
  return out;
}

const fieldItem = (block: string, name: string) =>
  htmlText(
    new RegExp(
      `field-name-${name}\\b[\\s\\S]*?<div class="field-item[^"]*"[^>]*>([\\s\\S]*?)<\\/div>`,
      "i",
    ).exec(block)?.[1] ?? "",
  );

export function parsePrsDate(raw: string): Date | null {
  const m = /([A-Za-z]{3,9})\s+(\d{1,2}),\s*(\d{4})/.exec(raw);
  const month = m ? monthNumber(m[1] ?? "") : null;
  return m && month ? istTimestamp(Number(m[3]), month, Number(m[2])) : null;
}

export function parsePrsStages(html: string): PrsStage[] {
  return html
    .split(/field-collection-item-field-own-status-details/i)
    .slice(1)
    .flatMap((block) => {
      const status = fieldItem(block, "field-own-status");
      if (!status) return [];
      const date = /<span class="date-display-single"[^>]*>([\s\S]*?)<\/span>/i.exec(block)?.[1];
      return [
        {
          status,
          house: fieldItem(block, "field-own-status-title") || null,
          date: date ? parsePrsDate(htmlText(date)) : null,
        },
      ];
    });
}

export function parsePrsBill(html: string, slug: string): PolicyDocument {
  const title = htmlText(/<h2[^>]*>([\s\S]*?)<\/h2>/i.exec(html)?.[1] ?? "");
  const stages = parsePrsStages(html);
  const latest = [...stages]
    .filter((s): s is PrsStage & { date: Date } => s.date !== null)
    .sort((a, b) => a.date.getTime() - b.date.getTime())
    .at(-1);
  if (!title || !latest)
    throw new UpstreamError("prs", "bill without title or dated stage", { slug });
  const body =
    /field-name-body\b[\s\S]*?property="content:encoded"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/i.exec(
      html,
    )?.[1];
  const paragraphs = [...(body ?? "").matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((p) => htmlText(p[1] ?? ""))
    .filter(Boolean);
  return {
    source: "prs",
    externalId: slug,
    title,
    ministry: fieldItem(html, "field-ministry") || null,
    stage: latest.house ? `${latest.status} (${latest.house})` : latest.status,
    publishedAt: latest.date,
    url: prsBillUrl(slug),
    text: paragraphs.join("\n"),
  };
}

export class PrsSource {
  constructor(private readonly http: HttpClient) {}

  private async page(url: string, signal?: AbortSignal): Promise<string> {
    const res = await this.http.get(url, { timeoutMs: 60_000, ...(signal ? { signal } : {}) });
    if (res.status !== 200) throw new UpstreamError("prs", `status ${res.status}`, { url });
    return res.text();
  }

  async bills(signal?: AbortSignal): Promise<PrsListing[]> {
    return parsePrsBillList(await this.page(PRS_BILLTRACK_URL, signal));
  }

  async bill(slug: string, signal?: AbortSignal): Promise<PolicyDocument> {
    return parsePrsBill(await this.page(prsBillUrl(slug), signal), slug);
  }
}
