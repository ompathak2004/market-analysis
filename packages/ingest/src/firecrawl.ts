import type { Logger } from "@ma/core";
import { UpstreamError } from "@ma/core";

export type FirecrawlFormat = "markdown" | "html" | "rawHtml";

export interface FirecrawlResult {
  markdown?: string;
  html?: string;
  rawHtml?: string;
  metadata: { statusCode?: number; title?: string; sourceURL?: string };
}

export class Firecrawl {
  constructor(
    private readonly apiKey: string,
    private readonly logger: Logger,
    private readonly baseUrl = "https://api.firecrawl.dev/v1",
  ) {}

  async scrape(
    url: string,
    formats: FirecrawlFormat[] = ["markdown"],
    waitForMs = 0,
  ): Promise<FirecrawlResult> {
    const started = Date.now();
    const res = await fetch(`${this.baseUrl}/scrape`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ url, formats, onlyMainContent: false, waitFor: waitForMs }),
      signal: AbortSignal.timeout(90_000),
    });
    const json = (await res.json()) as { success: boolean; error?: string; data?: FirecrawlResult };
    this.logger.debug({ url, status: res.status, ms: Date.now() - started }, "firecrawl scrape");
    if (!res.ok || !json.success || !json.data) {
      throw new UpstreamError("firecrawl", json.error ?? `status ${res.status}`, { url });
    }
    return json.data;
  }
}
