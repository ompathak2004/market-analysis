import { sparkPath } from "@/lib/chart";
import { tone } from "@/lib/format";

export function Sparkline({
  values,
  width = 80,
  height = 16,
  label,
}: {
  values: readonly number[];
  width?: number;
  height?: number;
  label?: string;
}) {
  if (values.length < 2) return <span className="muted">—</span>;
  const first = values[0] as number;
  const last = values.at(-1) as number;
  return (
    <svg
      className="spark"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={label ?? "trend"}
      data-tone={tone(last - first)}
    >
      <path d={sparkPath(values, width, height)} />
    </svg>
  );
}

export interface BarDatum {
  label: string;
  value: number;
  tone?: "pos" | "neg" | "accent";
}

export function Bars({
  data,
  height = 48,
  label,
  showLabels = true,
}: {
  data: readonly BarDatum[];
  height?: number;
  label: string;
  showLabels?: boolean;
}) {
  const w = 300;
  const labelH = showLabels ? 11 : 0;
  const max = Math.max(1, ...data.map((d) => Math.abs(d.value)));
  const slot = data.length ? w / data.length : w;
  const every = Math.max(1, Math.ceil(data.length / 6));
  return (
    <svg
      className="bars"
      viewBox={`0 0 ${w} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
      height={height}
    >
      {data.map((d, i) => {
        const h = (Math.abs(d.value) / max) * (height - labelH - 2);
        return (
          <rect
            key={`${d.label}-${String(i)}`}
            x={i * slot + slot * 0.15}
            y={height - labelH - h}
            width={Math.max(1, slot * 0.7)}
            height={Math.max(d.value ? 1 : 0, h)}
            data-tone={d.tone}
          >
            <title>{`${d.label}: ${d.value}`}</title>
          </rect>
        );
      })}
      {showLabels
        ? data.map((d, i) =>
            i % every === 0 ? (
              <text key={`t-${d.label}-${String(i)}`} x={i * slot + 1} y={height - 1}>
                {d.label}
              </text>
            ) : null,
          )
        : null}
    </svg>
  );
}

export function MiniRange({
  low,
  high,
  value,
  label,
}: {
  low: number | null;
  high: number | null;
  value: number | null;
  label: string;
}) {
  if (low == null || high == null || value == null || high <= low)
    return <svg className="mini-range" aria-hidden="true" />;
  const pos = Math.max(0, Math.min(1, (value - low) / (high - low))) * 100;
  return (
    <svg
      className="mini-range"
      viewBox="0 0 100 6"
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
    >
      <rect className="track" x="0" y="2" width="100" height="2" />
      <rect className="marker" x={Math.max(0, pos - 1)} y="0" width="2" height="6" />
    </svg>
  );
}
