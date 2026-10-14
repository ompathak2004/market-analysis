import type { Evidence as EvidenceItem } from "@ma/intel";
import { clampText, shortDate } from "@/lib/format";
import { sourceLabel } from "@/lib/splc";
import { Ext } from "./chip";

const KIND_LABEL: Record<EvidenceItem["kind"], string> = {
  filing: "FILING",
  broker_pdf: "BROKER",
  announcement: "ANN",
  concall: "CONCALL",
  source: "SOURCE",
  altdata: "ALT",
};

export function EvidenceRefs({ ids }: { ids: readonly string[] }) {
  if (!ids.length) return null;
  return <span className="evidence-ref">[{ids.join(", ")}]</span>;
}

export function EvidenceList({ items }: { items: readonly EvidenceItem[] }) {
  return (
    <ul className="evidence-list" data-rows>
      {items.map((e) => (
        <li key={e.id} data-row="" data-ext={e.url ?? undefined}>
          <span className="muted">{e.id}</span>
          <span className="dim">{KIND_LABEL[e.kind] ?? e.kind}</span>
          {e.url ? (
            <a
              className="ext"
              href={e.url}
              target="_blank"
              rel="noreferrer noopener"
              title={e.label}
            >
              {e.label}
            </a>
          ) : (
            <span title={e.label}>{e.label}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

export interface EvidenceSpanRef {
  quote: string;
  source: string;
  page: number | null;
  publishedAt: string | null;
  url: string | null;
}

export function EvidenceLine({
  items,
  max = 160,
}: {
  items: readonly EvidenceSpanRef[];
  max?: number;
}) {
  const ev = items[0];
  if (!ev) return <span className="evidence-line neg">no evidence span</span>;
  return (
    <span className="evidence-line">
      <span className="evidence-line-quote">“{clampText(ev.quote, max)}”</span>
      <span className="muted">
        {" "}
        {sourceLabel(ev.source)}
        {ev.page != null ? ` p.${ev.page}` : ""}
        {ev.publishedAt ? ` · ${shortDate(ev.publishedAt)}` : ""}
        {items.length > 1 ? ` · +${items.length - 1}` : ""}
      </span>{" "}
      <Ext href={ev.url}>DOC</Ext>
    </span>
  );
}
