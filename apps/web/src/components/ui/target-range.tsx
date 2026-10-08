export function TargetRange({
  low,
  mean,
  high,
  price,
}: {
  low: number;
  mean: number | null;
  high: number;
  price: number | null;
}) {
  const lo = Math.min(low, price ?? low);
  const hi = Math.max(high, price ?? high);
  const span = hi - lo || 1;
  const x = (v: number) => 10 + ((v - lo) / span) * 280;
  return (
    <svg
      className="range"
      viewBox="0 0 300 40"
      role="img"
      aria-label={`Target range ${low} to ${high}${price != null ? `, price ${price}` : ""}`}
    >
      <line className="track" x1="10" y1="16" x2="290" y2="16" />
      <line className="band" x1={x(low)} y1="16" x2={x(high)} y2="16" />
      {mean != null ? (
        <rect className="mark-mean" x={x(mean) - 2} y="9" width="4" height="14" />
      ) : null}
      {price != null ? (
        <path
          className="mark-price"
          d={`M${x(price) - 5} 4 L${x(price) + 5} 4 L${x(price)} 11 Z`}
        />
      ) : null}
      <text x={x(low)} y="36" textAnchor="start">
        L {low.toFixed(0)}
      </text>
      <text x={x(high)} y="36" textAnchor="end">
        H {high.toFixed(0)}
      </text>
      {mean != null ? (
        <text x={x(mean)} y="36" textAnchor="middle">
          μ {mean.toFixed(0)}
        </text>
      ) : null}
    </svg>
  );
}
