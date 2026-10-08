import { assertTimeLeft, deadlineSignal, type Logger, UpstreamError } from "@ma/core";
import type { FirecrawlBudget } from "./firecrawl-budget.js";

export type FirecrawlFormat = "markdown" | "html" | "rawHtml";

export interface FirecrawlResult {
  markdown?: string;
  html?: string;
  rawHtml?: string;
  metadata: { statusCode?: number; title?: string; sourceURL?: string };
}

export interface FirecrawlSearchResult {
  url: string;
  title: string | null;
  description: string | null;
  markdown: string | null;
}

const MIN_REQUEST_MS = 5_000;

interface SearchHit {
  url?: string;
  title?: string;
  description?: string;
  markdown?: string;
  metadata?: { title?: string; description?: string; sourceURL?: string };
}

class FirecrawlRejected extends UpstreamError {}

const searchCredits = (limit: number) => Math.max(1, Math.ceil(limit / 10) * 2);

export class Firecrawl {
  constructor(
    private readonly apiKey: string,
    private readonly logger: Logger,
    private readonly baseUrl = "https://api.firecrawl.dev/v1",
    private readonly budget: FirecrawlBudget | null = null,
  ) {}

  private async post<T>(
    path: string,
    body: unknown,
    context: Record<string, unknown>,
  ): Promise<{ data: T; creditsUsed: number | null }> {
    const started = Date.now();
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: deadlineSignal(90_000),
    });
    const json = (await res.json().catch(() => ({ success: false }))) as {
      success: boolean;
      error?: string;
      data?: T;
      creditsUsed?: number;
    };
    this.logger.debug(
      { ...context, path, status: res.status, ms: Date.now() - started },
      "firecrawl request",
    );
    if (!res.ok) {
      throw new FirecrawlRejected("firecrawl", json.error ?? `status ${res.status}`, context);
    }
    if (!json.success || !json.data) {
      throw new UpstreamError("firecrawl", json.error ?? `status ${res.status}`, context);
    }
    return { data: json.data, creditsUsed: json.creditsUsed ?? null };
  }

  private async charged<T>(
    estimate: number,
    call: () => Promise<{ data: T; creditsUsed: number | null }>,
    fallback: (data: T) => number,
  ): Promise<T> {
    assertTimeLeft(MIN_REQUEST_MS);
    const reservation = (await this.budget?.reserve(estimate)) ?? null;
    let result: { data: T; creditsUsed: number | null };
    try {
      result = await call();
    } catch (err) {
      if (reservation && err instanceof FirecrawlRejected) {
        await this.budget?.settle(reservation, 0);
      }
      throw err;
    }
    if (reservation) {
      await this.budget?.settle(reservation, result.creditsUsed ?? fallback(result.data));
    }
    return result.data;
  }

  async scrape(
    url: string,
    formats: FirecrawlFormat[] = ["markdown"],
    waitForMs = 0,
  ): Promise<FirecrawlResult> {
    return this.charged(
      1,
      () =>
        this.post<FirecrawlResult>(
          "/scrape",
          { url, formats, onlyMainContent: false, waitFor: waitForMs },
          { url },
        ),
      () => 1,
    );
  }

  async search(
    query: string,
    opts: { limit?: number; scrape?: boolean } = {},
  ): Promise<FirecrawlSearchResult[]> {
    const limit = Math.min(Math.max(opts.limit ?? 5, 1), 20);
    const scrape = opts.scrape ?? false;
    const estimate = searchCredits(limit) + (scrape ? limit : 0);
    const body = scrape
      ? { query, limit, scrapeOptions: { formats: ["markdown"], onlyMainContent: true } }
      : { query, limit };
    const data = await this.charged(
      estimate,
      () => this.post<SearchHit[]>("/search", body, { query }),
      (hits) => searchCredits(limit) + (scrape ? hits.length : 0),
    );
    return data.flatMap((d) => {
      const url = d.url ?? d.metadata?.sourceURL;
      if (!url) return [];
      return [
        {
          url,
          title: d.title ?? d.metadata?.title ?? null,
          description: d.description ?? d.metadata?.description ?? null,
          markdown: d.markdown ?? null,
        },
      ];
    });
  }
}
