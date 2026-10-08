import type { VerdictLabel } from "@ma/intel";

const BANDS: ReadonlyArray<{ from: number; to: number; label: VerdictLabel }> = [
  { from: 0, to: 20, label: "bearish" },
  { from: 20, to: 40, label: "cautious" },
  { from: 40, to: 60, label: "neutral" },
  { from: 60, to: 80, label: "constructive" },
  { from: 80, to: 100, label: "bullish" },
];

const CX = 100;
const CY = 96;
const R = 78;

function point(score: number, r = R) {
  const a = Math.PI - (Math.max(0, Math.min(100, score)) / 100) * Math.PI;
  return { x: CX + r * Math.cos(a), y: CY - r * Math.sin(a) };
}

function arc(from: number, to: number) {
  const a = point(from + 0.8);
  const b = point(to - 0.8);
  return `M${a.x.toFixed(2)} ${a.y.toFixed(2)} A${R} ${R} 0 0 1 ${b.x.toFixed(2)} ${b.y.toFixed(2)}`;
}

export function Gauge({
  score,
  label,
  confidence,
}: {
  score: number;
  label: VerdictLabel;
  confidence: number | null;
}) {
  const tip = point(score, R - 16);
  const conf = confidence != null ? `${Math.round(confidence * 100)}%` : "—";
  return (
    <svg
      className="gauge"
      viewBox="0 0 200 128"
      role="img"
      aria-label={`Verdict ${label} ${Math.round(score)} of 100, confidence ${conf}`}
    >
      {BANDS.map((b) => (
        <path
          key={b.label}
          className="seg"
          d={arc(b.from, b.to)}
          data-band={b.label}
          data-dim={score >= b.from && score <= b.to ? undefined : "true"}
        />
      ))}
      <text className="tick" x={CX - R - 2} y={CY + 12} textAnchor="middle">
        0
      </text>
      <text className="tick" x={CX + R + 2} y={CY + 12} textAnchor="middle">
        100
      </text>
      <line className="needle" x1={CX} y1={CY} x2={tip.x} y2={tip.y} />
      <circle className="hub" cx={CX} cy={CY} r={4} />
      <text className="score" x={CX} y={CY - 26} textAnchor="middle">
        {Math.round(score)}
      </text>
      <text className="tick" x={CX} y={CY + 22} textAnchor="middle">
        CONF {conf}
      </text>
    </svg>
  );
}
