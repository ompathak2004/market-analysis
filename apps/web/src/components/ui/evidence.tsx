import type { Evidence as EvidenceItem } from "@ma/intel";

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
