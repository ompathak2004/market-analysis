export interface DistPart {
  key: "sb" | "b" | "h" | "u" | "s";
  label: string;
  value: number;
}

export function Distribution({ parts, label }: { parts: readonly DistPart[]; label: string }) {
  const total = parts.reduce((s, p) => s + Math.max(0, p.value), 0);
  return (
    <div className="stack">
      <div className="dist" role="img" aria-label={label}>
        {total > 0
          ? parts.map((p) => (
              <span
                key={p.key}
                data-k={p.key}
                style={{ width: `${(Math.max(0, p.value) / total) * 100}%` }}
                title={`${p.label} ${p.value}`}
              />
            ))
          : null}
      </div>
      <div className="dist-legend">
        {parts.map((p) => (
          <span key={p.key}>
            {p.label}{" "}
            <b className="bright">{Number.isInteger(p.value) ? p.value : p.value.toFixed(1)}</b>
          </span>
        ))}
      </div>
    </div>
  );
}
