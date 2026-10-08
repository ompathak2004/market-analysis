import type { RateLimiter } from "@ma/cache";
import {
  assertTimeLeft,
  DeadlineExceededError,
  deadlineSignal,
  type Logger,
  RateLimitedError,
  remainingMs,
  sleep,
  UpstreamError,
} from "@ma/core";

const MIN_ATTEMPT_MS = 1_000;

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
  method?: "GET" | "POST";
  body?: string;
  signal?: AbortSignal;
}

export class HttpClient {
  constructor(
    private readonly limiter: RateLimiter,
    private readonly logger: Logger,
  ) {}

  post(url: string, body: string, opts: FetchOptions = {}): Promise<HttpResponse> {
    return this.get(url, { ...opts, method: "POST", body });
  }

  async get(url: string, opts: FetchOptions = {}): Promise<HttpResponse> {
    const host = new URL(url).hostname;
    const retries = opts.retries ?? 2;
    for (let attempt = 0; ; attempt++) {
      assertTimeLeft(MIN_ATTEMPT_MS);
      await this.limiter.acquire(host);
      const started = Date.now();
      try {
        const res = await this.once(url, opts);
        this.logger.debug({ url, status: res.status, ms: Date.now() - started }, "http get");
        if (res.status === 429 || res.status >= 500) {
          const delay = backoff(attempt, res.headers.get("retry-after"));
          if (attempt >= retries || !this.canRetry(delay, opts)) {
            throw new UpstreamError(host, `status ${res.status}`, { url });
          }
          await sleep(delay);
          continue;
        }
        return res;
      } catch (err) {
        if (
          err instanceof UpstreamError ||
          err instanceof RateLimitedError ||
          err instanceof DeadlineExceededError
        ) {
          throw err;
        }
        const delay = backoff(attempt, null);
        if (attempt >= retries || !this.canRetry(delay, opts)) {
          throw new UpstreamError(host, (err as Error).message, { url });
        }
        await sleep(delay);
      }
    }
  }

  private canRetry(delayMs: number, opts: FetchOptions): boolean {
    return !opts.signal?.aborted && remainingMs() >= delayMs + MIN_ATTEMPT_MS;
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
      method: opts.method ?? "GET",
      body: opts.body ?? null,
      headers,
      redirect: "follow",
      signal: deadlineSignal(opts.timeoutMs ?? 30_000, opts.signal ?? null),
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
