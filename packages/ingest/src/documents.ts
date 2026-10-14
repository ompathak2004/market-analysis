import { gunzipSync, gzipSync } from "node:zlib";
import {
  type Logger,
  type ObjectStore,
  objectKey,
  sha256,
  throwIfAborted,
  UpstreamError,
} from "@ma/core";
import {
  and,
  type Db,
  documentRevisions,
  documents,
  eq,
  fencedTransaction,
  isNull,
  type PageSpan,
  storageObjects,
  type Tx,
} from "@ma/db";
import { extractText, getDocumentProxy } from "unpdf";
import type { Firecrawl } from "./firecrawl.js";
import type { HttpClient } from "./http.js";

export type StoredDocument = typeof documents.$inferSelect;
export type DocumentRevision = typeof documentRevisions.$inferSelect;

export const TEXT_PARSER_VERSION = 1;
const TEXT_CACHE_ENTRIES = 8;
const TEXT_EXTENSION = "txt.gz";
const TEXT_CONTENT_TYPE = "text/plain; charset=utf-8";

export interface FetchDocumentOptions {
  source: string;
  companyId?: number | null;
  maxAgeMs?: number;
  headers?: Record<string, string>;
  via?: "direct" | "direct_only" | "firecrawl";
  extract?: (content: string) => string;
  pdfMaxPages?: number;
  publishedAt?: Date | null;
  signal?: AbortSignal;
}

export interface InlineDocumentOptions {
  source: string;
  companyId?: number | null;
  publishedAt?: Date | null;
  contentType?: string | null;
  signal?: AbortSignal;
}

export interface FetchDocumentResult {
  doc: StoredDocument;
  revision: DocumentRevision;
  text: string;
  changed: boolean;
  fromCache: boolean;
}

export interface SnapshotResult {
  revision: DocumentRevision;
  created: boolean;
  uploaded: boolean;
}

const BLOCKED = new Set([401, 403, 406, 451, 999]);

export class DocumentStore {
  private readonly texts = new Map<number, string>();

  constructor(
    private readonly db: Db,
    private readonly http: HttpClient,
    private readonly firecrawl: Firecrawl,
    private readonly logger: Logger,
    private readonly objects: ObjectStore | null = null,
  ) {}

  get hasObjectStore(): boolean {
    return this.objects !== null;
  }

  async fetch(url: string, opts: FetchDocumentOptions): Promise<FetchDocumentResult> {
    const existing = await this.db.query.documents.findFirst({ where: eq(documents.url, url) });
    const maxAge = opts.maxAgeMs ?? 0;
    if (existing && maxAge > 0 && Date.now() - existing.fetchedAt.getTime() < maxAge) {
      return this.current(existing, { changed: false, fromCache: true });
    }

    const fetched =
      opts.via === "firecrawl"
        ? await this.viaFirecrawl(url)
        : await this.viaDirect(url, existing, opts.headers, opts.pdfMaxPages, opts.signal, {
            fallback: opts.via !== "direct_only",
          });
    throwIfAborted(opts.signal);

    if (fetched.notModified && existing) {
      const [doc] = await this.db
        .update(documents)
        .set({ fetchedAt: new Date() })
        .where(eq(documents.id, existing.id))
        .returning();
      return this.current(doc as StoredDocument, { changed: false, fromCache: false });
    }

    let content = fetched.content.replaceAll("\u0000", "");
    let pageMap = fetched.pageMap;
    if (opts.extract) {
      content = opts.extract(content);
      pageMap = null;
    }
    const hash = sha256(content);
    if (existing && existing.sha256 === hash && existing.currentRevisionId !== null) {
      const [doc] = await this.db
        .update(documents)
        .set({ fetchedAt: new Date(), etag: fetched.etag, lastModified: fetched.lastModified })
        .where(eq(documents.id, existing.id))
        .returning();
      return this.current(doc as StoredDocument, { changed: false, fromCache: false });
    }

    return this.persist(url, existing, content, hash, pageMap, fetched, opts);
  }

  async putInline(
    url: string,
    content: string,
    opts: InlineDocumentOptions,
  ): Promise<FetchDocumentResult> {
    const existing = await this.db.query.documents.findFirst({ where: eq(documents.url, url) });
    const clean = content.replaceAll("\u0000", "");
    const hash = sha256(clean);
    if (existing && existing.sha256 === hash && existing.currentRevisionId !== null) {
      return this.current(existing, { changed: false, fromCache: true });
    }
    const meta = {
      contentType: opts.contentType ?? TEXT_CONTENT_TYPE,
      etag: null,
      lastModified: null,
    };
    return this.persist(url, existing, clean, hash, null, meta, opts);
  }

  private async persist(
    url: string,
    existing: StoredDocument | undefined,
    content: string,
    hash: string,
    pageMap: PageSpan[] | null,
    meta: Pick<Fetched, "contentType" | "etag" | "lastModified">,
    opts: Pick<FetchDocumentOptions, "source" | "companyId" | "publishedAt" | "signal">,
  ): Promise<FetchDocumentResult> {
    const stored = await this.store(content, hash);
    const now = new Date();
    const row = {
      url,
      source: opts.source,
      companyId: opts.companyId ?? null,
      sha256: hash,
      contentType: meta.contentType,
      etag: meta.etag,
      lastModified: meta.lastModified,
      byteSize: Buffer.byteLength(content),
      content,
      status: "fetched" as const,
      parserVersion: null,
      textParserVersion: TEXT_PARSER_VERSION,
      publishedAt: opts.publishedAt ?? existing?.publishedAt ?? null,
      fetchedAt: now,
      parsedAt: null,
    };
    const result = await fencedTransaction(
      this.db,
      async (tx) => {
        const [doc] = await tx
          .insert(documents)
          .values(row)
          .onConflictDoUpdate({ target: documents.url, set: row })
          .returning();
        if (!doc) throw new Error(`document upsert failed for ${url}`);
        const revision = await this.insertRevision(tx, {
          documentId: doc.id,
          contentSha256: hash,
          textParserVersion: TEXT_PARSER_VERSION,
          textS3Key: stored.key,
          textBytes: row.byteSize,
          pageMap,
          mimeType: meta.contentType,
          publishedAt: row.publishedAt,
          fetchedAt: now,
          rawUnavailable: true,
        });
        if (stored.key) await this.recordObject(tx, stored.key, hash, stored.bytes);
        const [current] = await tx
          .update(documents)
          .set({ currentRevisionId: revision.id })
          .where(eq(documents.id, doc.id))
          .returning();
        return { doc: current as StoredDocument, revision };
      },
      opts.signal,
    );
    this.remember(result.revision.id, content);
    this.logger.info(
      {
        url,
        source: opts.source,
        bytes: row.byteSize,
        revision: result.revision.id,
        archived: Boolean(stored.key),
        replaced: Boolean(existing),
      },
      "document stored",
    );
    return { ...result, text: content, changed: true, fromCache: false };
  }

  async snapshot(doc: StoredDocument, signal?: AbortSignal): Promise<SnapshotResult | null> {
    const content = doc.content;
    if (content === null) return null;
    if (doc.currentRevisionId !== null) {
      const existing = await this.revision(doc.currentRevisionId);
      if (existing) return { revision: existing, created: false, uploaded: false };
    }
    const hash = sha256(content);
    const stored = await this.store(content, hash);
    const revision = await fencedTransaction(
      this.db,
      async (tx) => {
        const created = await this.insertRevision(tx, {
          documentId: doc.id,
          contentSha256: hash,
          textParserVersion: doc.textParserVersion,
          textS3Key: stored.key,
          textBytes: Buffer.byteLength(content),
          pageMap: null,
          mimeType: doc.contentType,
          publishedAt: doc.publishedAt,
          fetchedAt: doc.fetchedAt,
          rawUnavailable: true,
        });
        if (stored.key) await this.recordObject(tx, stored.key, hash, stored.bytes);
        await tx
          .update(documents)
          .set({ currentRevisionId: created.id, sha256: hash })
          .where(and(eq(documents.id, doc.id), isNull(documents.currentRevisionId)));
        return created;
      },
      signal,
    );
    return { revision, created: true, uploaded: Boolean(stored.key) };
  }

  async text(
    revision: DocumentRevision,
    doc?: Pick<StoredDocument, "content"> | null,
  ): Promise<string> {
    const cached = this.texts.get(revision.id);
    if (cached !== undefined) return cached;
    const inline = doc ? doc.content : await this.inlineText(revision);
    if (inline !== null && inline !== undefined) {
      this.remember(revision.id, inline);
      return inline;
    }
    if (!this.objects || !revision.textS3Key) {
      throw new UpstreamError("documents", "revision text unavailable", {
        revisionId: revision.id,
      });
    }
    const body = await this.objects.get(revision.textS3Key);
    if (!body) {
      throw new UpstreamError("documents", "revision object missing", {
        revisionId: revision.id,
        key: revision.textS3Key,
      });
    }
    const text = gunzipSync(body).toString("utf8");
    if (sha256(text) !== revision.contentSha256) {
      throw new UpstreamError("documents", "revision checksum mismatch", {
        revisionId: revision.id,
      });
    }
    this.remember(revision.id, text);
    return text;
  }

  async textOf(documentId: number): Promise<string | null> {
    const doc = await this.db.query.documents.findFirst({ where: eq(documents.id, documentId) });
    if (!doc) return null;
    if (doc.content !== null) return doc.content;
    const revision =
      doc.currentRevisionId === null ? null : await this.revision(doc.currentRevisionId);
    return revision ? this.text(revision, doc) : null;
  }

  async revision(id: number): Promise<DocumentRevision | null> {
    return (
      (await this.db.query.documentRevisions.findFirst({ where: eq(documentRevisions.id, id) })) ??
      null
    );
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

  private async current(
    doc: StoredDocument,
    flags: { changed: boolean; fromCache: boolean },
  ): Promise<FetchDocumentResult> {
    let revision =
      doc.currentRevisionId === null ? null : await this.revision(doc.currentRevisionId);
    if (!revision) {
      const snap = await this.snapshot(doc);
      if (!snap) {
        throw new UpstreamError("documents", "document has neither body nor revision", {
          documentId: doc.id,
        });
      }
      revision = snap.revision;
      doc = { ...doc, currentRevisionId: revision.id };
    }
    return { doc, revision, text: await this.text(revision, doc), ...flags };
  }

  private async inlineText(revision: DocumentRevision): Promise<string | null> {
    const row = await this.db.query.documents.findFirst({
      columns: { content: true, currentRevisionId: true },
      where: eq(documents.id, revision.documentId),
    });
    return row && row.currentRevisionId === revision.id ? row.content : null;
  }

  private async store(
    content: string,
    hash: string,
  ): Promise<{ key: string | null; bytes: number }> {
    if (!this.objects) return { key: null, bytes: 0 };
    const key = objectKey("text", hash, TEXT_EXTENSION);
    const body = gzipSync(Buffer.from(content, "utf8"));
    await this.objects.put(key, body, sha256(body), TEXT_CONTENT_TYPE);
    return { key, bytes: body.byteLength };
  }

  private async insertRevision(
    db: Db | Tx,
    row: typeof documentRevisions.$inferInsert,
  ): Promise<DocumentRevision> {
    const [created] = await db
      .insert(documentRevisions)
      .values(row)
      .onConflictDoNothing({
        target: [
          documentRevisions.documentId,
          documentRevisions.contentSha256,
          documentRevisions.textParserVersion,
        ],
      })
      .returning();
    if (created) return created;
    const existing = await db.query.documentRevisions.findFirst({
      where: and(
        eq(documentRevisions.documentId, row.documentId),
        eq(documentRevisions.contentSha256, row.contentSha256),
        eq(documentRevisions.textParserVersion, row.textParserVersion ?? 0),
      ),
    });
    if (!existing) throw new Error(`revision insert failed for document ${row.documentId}`);
    return existing;
  }

  private async recordObject(db: Db | Tx, key: string, hash: string, bytes: number) {
    await db
      .insert(storageObjects)
      .values({ key, sha256: hash, bytes, kind: "text" })
      .onConflictDoNothing();
  }

  private remember(revisionId: number, text: string): void {
    this.texts.delete(revisionId);
    this.texts.set(revisionId, text);
    while (this.texts.size > TEXT_CACHE_ENTRIES) {
      const oldest = this.texts.keys().next().value;
      if (oldest === undefined) break;
      this.texts.delete(oldest);
    }
  }

  private async viaDirect(
    url: string,
    existing: StoredDocument | undefined,
    headers?: Record<string, string>,
    pdfMaxPages?: number,
    signal?: AbortSignal,
    mode: { fallback: boolean } = { fallback: true },
  ): Promise<Fetched> {
    const res = await this.http.get(url, {
      ...(signal ? { signal } : {}),
      etag: existing?.etag ?? null,
      lastModified: existing?.lastModified ?? null,
      ...(headers ? { headers } : {}),
    });
    if (res.notModified)
      return {
        notModified: true,
        content: "",
        pageMap: null,
        contentType: null,
        etag: null,
        lastModified: null,
      };
    if (mode.fallback && BLOCKED.has(res.status)) {
      this.logger.warn(
        { url, status: res.status },
        "direct fetch blocked, falling back to firecrawl",
      );
      return this.viaFirecrawl(url);
    }
    if (res.status >= 400)
      throw new UpstreamError(new URL(url).hostname, `status ${res.status}`, { url });
    const contentType = res.headers.get("content-type");
    const parsed = isPdf(contentType, url, res.body)
      ? await pdfToText(res.body, pdfMaxPages)
      : { text: res.text(), pageMap: null };
    return {
      notModified: false,
      content: parsed.text,
      pageMap: parsed.pageMap,
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
      pageMap: null,
      contentType: wantsHtml ? "text/html; via=firecrawl" : "text/markdown; via=firecrawl",
      etag: null,
      lastModified: null,
    };
  }
}

interface Fetched {
  notModified: boolean;
  content: string;
  pageMap: PageSpan[] | null;
  contentType: string | null;
  etag: string | null;
  lastModified: string | null;
}

export interface ParsedPdf {
  text: string;
  pageMap: PageSpan[];
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

export function joinPages(pages: readonly string[]): ParsedPdf {
  let text = "";
  const pageMap: PageSpan[] = [];
  pages.forEach((page, i) => {
    if (i > 0) text += "\n\n";
    const start = text.length;
    text += page;
    pageMap.push({ page: i + 1, start, end: text.length });
  });
  return { text, pageMap };
}

export function pageOf(pageMap: readonly PageSpan[] | null | undefined, offset: number) {
  if (!pageMap) return null;
  for (const span of pageMap) if (offset >= span.start && offset < span.end) return span.page;
  return null;
}

export async function pdfToText(body: Uint8Array, maxPages?: number): Promise<ParsedPdf> {
  const pdf = await getDocumentProxy(body);
  const limit = maxPages === undefined ? pdf.numPages : Math.min(maxPages, pdf.numPages);
  if (limit === pdf.numPages) {
    const { text } = await extractText(pdf, { mergePages: false });
    return joinPages(text.map((p) => p.trim()));
  }
  const pages: string[] = [];
  for (let i = 1; i <= limit; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    pages.push(
      content.items
        .map((item) => ("str" in item ? item.str : ""))
        .join(" ")
        .trim(),
    );
  }
  return joinPages(pages);
}
