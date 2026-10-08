import type { Logger } from "@ma/core";
import { UpstreamError } from "@ma/core";
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
      signal: AbortSignal.timeout(90_000),
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
    if (!res.ok || !json.success || !json.data) {
      throw new UpstreamError("firecrawl", json.error ?? `status ${res.status}`, context);
    }
    return { data: json.data, creditsUsed: json.creditsUsed ?? null };
  }

  async scrape(
    url: string,
    formats: FirecrawlFormat[] = ["markdown"],
    waitForMs = 0,
  ): Promise<FirecrawlResult> {
    await this.budget?.ensure(1);
    const { data, creditsUsed } = await this.post<FirecrawlResult>(
      "/scrape",
      { url, formats, onlyMainContent: false, waitFor: waitForMs },
      { url },
    );
    await this.budget?.consume(creditsUsed ?? 1);
    return data;
  }

  async search(
    query: string,
    opts: { limit?: number; scrape?: boolean } = {},
  ): Promise<FirecrawlSearchResult[]> {
    const limit = Math.min(Math.max(opts.limit ?? 5, 1), 20);
    const scrape = opts.scrape ?? false;
    const estimate = searchCredits(limit) + (scrape ? limit : 0);
    await this.budget?.ensure(estimate);
    const body = scrape
      ? { query, limit, scrapeOptions: { formats: ["markdown"], onlyMainContent: true } }
      : { query, limit };
    const { data, creditsUsed } = await this.post<
      Array<{
        url?: string;
        title?: string;
        description?: string;
        markdown?: string;
        metadata?: { title?: string; description?: string; sourceURL?: string };
      }>
    >("/search", body, { query });
    await this.budget?.consume(creditsUsed ?? searchCredits(limit) + (scrape ? data.length : 0));
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
