import type { RateLimiter } from "@ma/cache";
import { type Logger, RateLimitedError, sleep, UpstreamError } from "@ma/core";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";

export interface HttpResponse {
  status: number;
  body: Uint8Array;
  text: () => string;
  headers: Headers;
  notModified: boolean;
}

export interface FetchOptions {
  headers?: Record<string, string>;
  etag?: string | null;
  lastModified?: string | null;
  timeoutMs?: number;
  retries?: number;
}

export class HttpClient {
  constructor(
    private readonly limiter: RateLimiter,
    private readonly logger: Logger,
  ) {}

  async get(url: string, opts: FetchOptions = {}): Promise<HttpResponse> {
    const host = new URL(url).hostname;
    const retries = opts.retries ?? 2;
    for (let attempt = 0; ; attempt++) {
      await this.limiter.acquire(host);
      const started = Date.now();
      try {
        const res = await this.once(url, opts);
        this.logger.debug({ url, status: res.status, ms: Date.now() - started }, "http get");
        if (res.status === 429 || res.status >= 500) {
          if (attempt >= retries) throw new UpstreamError(host, `status ${res.status}`, { url });
          await sleep(backoff(attempt, res.headers.get("retry-after")));
          continue;
        }
        return res;
      } catch (err) {
        if (err instanceof UpstreamError || err instanceof RateLimitedError) throw err;
        if (attempt >= retries) throw new UpstreamError(host, (err as Error).message, { url });
        await sleep(backoff(attempt, null));
      }
    }
  }

  private async once(url: string, opts: FetchOptions): Promise<HttpResponse> {
    const headers: Record<string, string> = {
      "user-agent": UA,
      accept: "text/html,application/json,application/pdf,*/*;q=0.8",
      "accept-language": "en-US,en;q=0.9",
      ...opts.headers,
    };
    if (opts.etag) headers["if-none-match"] = opts.etag;
    if (opts.lastModified) headers["if-modified-since"] = opts.lastModified;
    const res = await fetch(url, {
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
    });
    const body = res.status === 304 ? new Uint8Array() : new Uint8Array(await res.arrayBuffer());
    let decoded: string | undefined;
    return {
      status: res.status,
      body,
      headers: res.headers,
      notModified: res.status === 304,
      text: () => (decoded ??= new TextDecoder().decode(body)),
    };
  }
}

function backoff(attempt: number, retryAfter: string | null): number {
  const hinted = retryAfter ? Number(retryAfter) * 1000 : 0;
  return Math.max(hinted, 500 * 2 ** attempt + Math.random() * 250);
}
