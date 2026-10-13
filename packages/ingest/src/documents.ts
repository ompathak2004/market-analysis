import { type Logger, sha256, throwIfAborted, UpstreamError } from "@ma/core";
import { type Db, documents, eq, type Tx } from "@ma/db";
import { extractText, getDocumentProxy } from "unpdf";
import type { Firecrawl } from "./firecrawl.js";
import type { HttpClient } from "./http.js";

export type StoredDocument = typeof documents.$inferSelect;

export interface FetchDocumentOptions {
  source: string;
  companyId?: number | null;
  maxAgeMs?: number;
  headers?: Record<string, string>;
  via?: "direct" | "firecrawl";
  extract?: (content: string) => string;
  pdfMaxPages?: number;
  signal?: AbortSignal;
}

export interface FetchDocumentResult {
  doc: StoredDocument;
  changed: boolean;
  fromCache: boolean;
}

const BLOCKED = new Set([401, 403, 406, 451, 999]);

export class DocumentStore {
  constructor(
    private readonly db: Db,
    private readonly http: HttpClient,
    private readonly firecrawl: Firecrawl,
    private readonly logger: Logger,
  ) {}

  async fetch(url: string, opts: FetchDocumentOptions): Promise<FetchDocumentResult> {
    const existing = await this.db.query.documents.findFirst({ where: eq(documents.url, url) });
    const maxAge = opts.maxAgeMs ?? 0;
    if (existing && maxAge > 0 && Date.now() - existing.fetchedAt.getTime() < maxAge) {
      return { doc: existing, changed: false, fromCache: true };
    }

    const fetched =
      opts.via === "firecrawl"
        ? await this.viaFirecrawl(url)
        : await this.viaDirect(url, existing, opts.headers, opts.pdfMaxPages, opts.signal);
    throwIfAborted(opts.signal);

    if (fetched.notModified && existing) {
      const [doc] = await this.db
        .update(documents)
        .set({ fetchedAt: new Date() })
        .where(eq(documents.id, existing.id))
        .returning();
      return { doc: doc as StoredDocument, changed: false, fromCache: false };
    }

    fetched.content = fetched.content.replaceAll("\u0000", "");
    if (opts.extract) fetched.content = opts.extract(fetched.content);
    const hash = sha256(fetched.content);
    if (existing && existing.sha256 === hash) {
      const [doc] = await this.db
        .update(documents)
        .set({ fetchedAt: new Date(), etag: fetched.etag, lastModified: fetched.lastModified })
        .where(eq(documents.id, existing.id))
        .returning();
      return { doc: doc as StoredDocument, changed: false, fromCache: false };
    }

    const row = {
      url,
      source: opts.source,
      companyId: opts.companyId ?? null,
      sha256: hash,
      contentType: fetched.contentType,
      etag: fetched.etag,
      lastModified: fetched.lastModified,
      byteSize: Buffer.byteLength(fetched.content),
      content: fetched.content,
      status: "fetched" as const,
      parserVersion: null,
      fetchedAt: new Date(),
      parsedAt: null,
    };
    const [doc] = await this.db
      .insert(documents)
      .values(row)
      .onConflictDoUpdate({ target: documents.url, set: row })
      .returning();
    this.logger.info(
      { url, source: opts.source, bytes: row.byteSize, replaced: Boolean(existing) },
      "document stored",
    );
    return { doc: doc as StoredDocument, changed: true, fromCache: false };
  }

  async markParsed(
    id: number,
    parserVersion: number,
    status: "parsed" | "failed" = "parsed",
    db: Db | Tx = this.db,
  ): Promise<void> {
    await db
      .update(documents)
      .set({ status, parserVersion, parsedAt: new Date() })
      .where(eq(documents.id, id));
  }

  private async viaDirect(
    url: string,
    existing: StoredDocument | undefined,
    headers?: Record<string, string>,
    pdfMaxPages?: number,
    signal?: AbortSignal,
  ): Promise<Fetched> {
    const res = await this.http.get(url, {
      ...(signal ? { signal } : {}),
      etag: existing?.etag ?? null,
      lastModified: existing?.lastModified ?? null,
      ...(headers ? { headers } : {}),
    });
    if (res.notModified)
      return { notModified: true, content: "", contentType: null, etag: null, lastModified: null };
    if (BLOCKED.has(res.status)) {
      this.logger.warn(
        { url, status: res.status },
        "direct fetch blocked, falling back to firecrawl",
      );
      return this.viaFirecrawl(url);
    }
    if (res.status >= 400)
      throw new UpstreamError(new URL(url).hostname, `status ${res.status}`, { url });
    const contentType = res.headers.get("content-type");
    const content = isPdf(contentType, url, res.body)
      ? await pdfToText(res.body, pdfMaxPages)
      : res.text();
    return {
      notModified: false,
      content,
      contentType,
      etag: res.headers.get("etag"),
      lastModified: res.headers.get("last-modified"),
    };
  }

  private async viaFirecrawl(url: string): Promise<Fetched> {
    const wantsHtml = !url.toLowerCase().endsWith(".pdf");
    const data = await this.firecrawl.scrape(url, wantsHtml ? ["rawHtml"] : ["markdown"]);
    const content = (wantsHtml ? data.rawHtml : data.markdown) ?? "";
    if (!content) throw new UpstreamError("firecrawl", "empty content", { url });
    return {
      notModified: false,
      content,
      contentType: wantsHtml ? "text/html; via=firecrawl" : "text/markdown; via=firecrawl",
      etag: null,
      lastModified: null,
    };
  }
}

interface Fetched {
  notModified: boolean;
  content: string;
  contentType: string | null;
  etag: string | null;
  lastModified: string | null;
}

function isPdf(contentType: string | null, url: string, body: Uint8Array): boolean {
  if (contentType?.includes("pdf")) return true;
  if (
    body.length >= 5 &&
    body[0] === 0x25 &&
    body[1] === 0x50 &&
    body[2] === 0x44 &&
    body[3] === 0x46
  )
    return true;
  return url.toLowerCase().endsWith(".pdf");
}

export async function pdfToText(body: Uint8Array, maxPages?: number): Promise<string> {
  const pdf = await getDocumentProxy(body);
  if (maxPages === undefined || pdf.numPages <= maxPages) {
    const { text } = await extractText(pdf, { mergePages: true });
    return text;
  }
  const pages: string[] = [];
  for (let i = 1; i <= maxPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    pages.push(
      content.items
        .map((item) => ("str" in item ? item.str : ""))
        .join(" ")
        .trim(),
    );
  }
  return pages.join("\n\n");
}
