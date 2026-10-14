import { decodeXml } from "./nse-xbrl.js";

export interface LineSnapshot {
  content: string;
  spans: Map<string, { start: number; end: number }>;
}

export function decodeHtml(s: string): string {
  return decodeXml(s.replace(/&nbsp;/gi, " ").replace(/&rsquo;|&lsquo;/gi, "'"));
}

export function htmlText(html: string): string {
  return decodeHtml(
    html
      .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

export function lineSnapshot<T>(
  head: Record<string, unknown>,
  items: readonly T[],
  key: (item: T) => string,
  body: (item: T) => Record<string, unknown>,
): LineSnapshot {
  const spans = new Map<string, { start: number; end: number }>();
  let content = `${JSON.stringify(head)}\n`;
  const sorted = [...items].sort((a, b) => key(a).localeCompare(key(b)));
  for (const item of sorted) {
    const k = key(item);
    if (spans.has(k)) continue;
    const line = JSON.stringify({ key: k, ...body(item) });
    spans.set(k, { start: content.length, end: content.length + line.length });
    content += `${line}\n`;
  }
  return { content, spans };
}

export interface SnapshotLine {
  start: number;
  end: number;
  row: Record<string, unknown>;
}

export function readLineSnapshot(content: string): Map<string, SnapshotLine> {
  const out = new Map<string, SnapshotLine>();
  let start = content.indexOf("\n") + 1;
  while (start > 0 && start < content.length) {
    const next = content.indexOf("\n", start);
    const end = next < 0 ? content.length : next;
    const row = JSON.parse(content.slice(start, end)) as Record<string, unknown>;
    if (typeof row.key === "string") out.set(row.key, { start, end, row });
    start = end + 1;
  }
  return out;
}
