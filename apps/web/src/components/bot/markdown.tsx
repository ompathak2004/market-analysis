"use client";

import { Fragment, type ReactNode } from "react";

type Block =
  | { kind: "h"; text: string }
  | { kind: "p"; text: string }
  | { kind: "ul" | "ol"; items: string[] }
  | { kind: "table"; head: string[]; rows: string[][] };

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());

function parse(src: string): Block[] {
  const lines = src.replace(/\r/g, "").split("\n");
  const out: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push({ kind: "p", text: para.join(" ") });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const t = line.trim();
    if (!t) {
      flush();
      continue;
    }
    const h = /^#{1,6}\s+(.*)$/.exec(t);
    if (h) {
      flush();
      out.push({ kind: "h", text: h[1] ?? "" });
      continue;
    }
    if (t.startsWith("|") && /^\|?\s*:?-{2,}/.test((lines[i + 1] ?? "").trim())) {
      flush();
      const head = cells(t);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && (lines[i] ?? "").trim().startsWith("|"))
        rows.push(cells(lines[i++] ?? ""));
      i--;
      out.push({ kind: "table", head, rows });
      continue;
    }
    const ul = /^[-*•]\s+(.*)$/.exec(t);
    const ol = /^\d+[.)]\s+(.*)$/.exec(t);
    if (ul || ol) {
      flush();
      const kind = ul ? "ul" : "ol";
      const last = out.at(-1);
      const item = (ul ?? ol)?.[1] ?? "";
      if (last && last.kind === kind) last.items.push(item);
      else out.push({ kind, items: [item] });
      continue;
    }
    if (/^-{3,}$/.test(t)) {
      flush();
      continue;
    }
    para.push(t);
  }
  flush();
  return out;
}

const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\[\s*S\d{1,3}\s*\]|\*[^*\s][^*]*\*|_[^_\s][^_]*_)/g;

function inline(text: string, cite: (id: string) => ReactNode): ReactNode[] {
  return text.split(INLINE).map((part, i) => {
    const key = String(i);
    if (!part) return null;
    if (part.startsWith("**")) return <strong key={key}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("`")) return <code key={key}>{part.slice(1, -1)}</code>;
    const c = /^\[\s*(S\d{1,3})\s*\]$/.exec(part);
    if (c?.[1]) return <Fragment key={key}>{cite(c[1])}</Fragment>;
    if (/^(\*|_)[^*_]/.test(part) && part.length > 2 && (part.endsWith("*") || part.endsWith("_")))
      return <em key={key}>{part.slice(1, -1)}</em>;
    return <Fragment key={key}>{part}</Fragment>;
  });
}

export function Markdown({ text, cite }: { text: string; cite: (id: string) => ReactNode }) {
  return (
    <div className="md">
      {parse(text).map((b, i) => {
        const key = String(i);
        if (b.kind === "h") return <h4 key={key}>{inline(b.text, cite)}</h4>;
        if (b.kind === "p") return <p key={key}>{inline(b.text, cite)}</p>;
        if (b.kind === "table")
          return (
            <div key={key} className="md-table scroll">
              <table className="dt">
                <thead>
                  <tr>
                    {b.head.map((h, j) => (
                      <th key={String(j)}>{inline(h, cite)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {b.rows.map((r, j) => (
                    <tr key={String(j)}>
                      {r.map((c, k) => (
                        <td key={String(k)}>{inline(c, cite)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        const List = b.kind;
        return (
          <List key={key}>
            {b.items.map((it, j) => (
              <li key={String(j)}>{inline(it, cite)}</li>
            ))}
          </List>
        );
      })}
    </div>
  );
}
