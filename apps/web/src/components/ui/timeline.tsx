import type { ReactNode } from "react";
import { shortDate } from "@/lib/format";

export interface TimelineItem {
  key: string;
  at: string | null;
  tone?: "pos" | "neg" | "neu" | "warn" | "accent";
  body: ReactNode;
  href?: string;
}

export function Timeline({ items }: { items: readonly TimelineItem[] }) {
  return (
    <ol className="timeline" data-rows>
      {items.map((it) => (
        <li key={it.key} data-tone={it.tone ?? "neu"} data-row="" data-href={it.href}>
          <time dateTime={it.at ?? undefined}>{shortDate(it.at)}</time>
          <i aria-hidden="true" />
          <div className="truncate">{it.body}</div>
        </li>
      ))}
    </ol>
  );
}
