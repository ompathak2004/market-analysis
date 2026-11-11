import { createHash, randomUUID } from "node:crypto";

export type AttrValue = string | number | boolean | null | string[];
export type Attrs = Record<string, AttrValue>;

export interface Span {
  id: string;
  parentId: string | null;
  name: string;
  startMs: number;
  endMs: number | null;
  status: "ok" | "error" | "unset";
  attrs: Attrs;
  events: Array<{ name: string; atMs: number; attrs: Attrs }>;
}

export interface TraceRecord {
  traceId: string;
  startedAt: string;
  durationMs: number | null;
  attrs: Attrs;
  spans: Span[];
}

const SECRET_KEY = /key|token|secret|password|authorization|cookie/i;
const MAX_SPANS = 200;

export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

export function redact(value: unknown, maxString = 160, depth = 0): unknown {
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string")
    return value.length > maxString ? `${value.slice(0, maxString)}…` : value;
  if (depth > 4) return "[depth]";
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, maxString, depth + 1));
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        SECRET_KEY.test(k) ? "[redacted]" : redact(v, maxString, depth + 1),
      ]),
    );
  }
  return String(value);
}

export class SpanHandle {
  constructor(
    private readonly trace: Trace,
    readonly span: Span,
  ) {}

  get id(): string {
    return this.span.id;
  }

  set(attrs: Attrs): this {
    Object.assign(this.span.attrs, attrs);
    return this;
  }

  event(name: string, attrs: Attrs = {}): this {
    if (this.span.events.length < 50)
      this.span.events.push({ name, atMs: this.trace.elapsed(), attrs });
    return this;
  }

  end(status: "ok" | "error" = "ok", attrs: Attrs = {}): void {
    if (this.span.endMs != null) return;
    Object.assign(this.span.attrs, attrs);
    this.span.status = status;
    this.span.endMs = this.trace.elapsed();
  }
}

export class Trace {
  readonly traceId: string;
  readonly startedAt = new Date();
  private readonly t0 = performance.now();
  private readonly spans: Span[] = [];
  private durationMs: number | null = null;
  readonly attrs: Attrs;

  constructor(attrs: Attrs = {}, traceId: string = randomUUID()) {
    this.traceId = traceId;
    this.attrs = { ...attrs };
  }

  elapsed(): number {
    return Math.round(performance.now() - this.t0);
  }

  span(name: string, attrs: Attrs = {}, parent: SpanHandle | null = null): SpanHandle {
    const span: Span = {
      id: randomUUID().slice(0, 16),
      parentId: parent?.id ?? null,
      name,
      startMs: this.elapsed(),
      endMs: null,
      status: "unset",
      attrs: { ...attrs },
      events: [],
    };
    if (this.spans.length < MAX_SPANS) this.spans.push(span);
    return new SpanHandle(this, span);
  }

  async wrap<T>(
    name: string,
    attrs: Attrs,
    fn: (s: SpanHandle) => Promise<T>,
    parent: SpanHandle | null = null,
  ): Promise<T> {
    const s = this.span(name, attrs, parent);
    try {
      const out = await fn(s);
      s.end("ok");
      return out;
    } catch (err) {
      s.end("error", {
        "error.message": err instanceof Error ? err.message.slice(0, 300) : String(err),
      });
      throw err;
    }
  }

  finish(attrs: Attrs = {}): TraceRecord {
    Object.assign(this.attrs, attrs);
    this.durationMs ??= this.elapsed();
    for (const s of this.spans) if (s.endMs == null) s.endMs = this.durationMs;
    return this.toJSON();
  }

  toJSON(): TraceRecord {
    return {
      traceId: this.traceId,
      startedAt: this.startedAt.toISOString(),
      durationMs: this.durationMs,
      attrs: this.attrs,
      spans: this.spans,
    };
  }
}
