import { type Bar, buildChart, VIEW_H, VIEW_W } from "@/lib/chart";
import { num } from "@/lib/format";
import { CandlesCrosshair } from "./candles-crosshair";

export function Candles({
  bars,
  history,
  readoutId,
  label,
}: {
  bars: readonly Bar[];
  history: readonly Bar[];
  readoutId: string;
  label: string;
}) {
  const g = buildChart(bars, history);
  const pctY = (y: number) => `${(y / VIEW_H) * 100}%`;
  const pctX = (x: number) => `${(x / VIEW_W) * 100}%`;
  return (
    <div className="candles">
      <div className="candles-plot">
        <svg
          className="chart"
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={label}
        >
          {g.yTicks.map((t) => (
            <line key={t.label} className="grid-line" x1="0" x2={VIEW_W} y1={t.y} y2={t.y} />
          ))}
          <line className="grid-line" x1="0" x2={VIEW_W} y1="810" y2="810" />
          {g.candles.map((c, i) => (
            <g key={g.bars[i]?.date ?? String(i)} className={c.up ? "candle-up" : "candle-down"}>
              <line className="wick" x1={c.x} x2={c.x} y1={c.yHigh} y2={c.yLow} />
              <rect
                x={c.x - c.w / 2}
                y={Math.min(c.yOpen, c.yClose)}
                width={c.w}
                height={Math.max(1.5, Math.abs(c.yClose - c.yOpen))}
              />
              <rect
                className={c.up ? "vol-up" : "vol-down"}
                x={c.x - c.w / 2}
                y={c.volY}
                width={c.w}
                height={VIEW_H - c.volY}
                stroke="none"
              />
            </g>
          ))}
          {g.sma200 ? <path className="sma200" d={g.sma200} /> : null}
          {g.sma50 ? <path className="sma50" d={g.sma50} /> : null}
          {g.last ? (
            <line className="last-line" x1="0" x2={VIEW_W} y1={g.last.y} y2={g.last.y} />
          ) : null}
        </svg>
        <CandlesCrosshair
          bars={g.bars.map((b) => [b.date, b.open, b.high, b.low, b.close, b.volume] as const)}
          readoutId={readoutId}
        />
      </div>
      <div className="candles-y" aria-hidden="true">
        {g.yTicks.map((t) => (
          <span key={t.label} style={{ top: pctY(t.y) }}>
            {num(t.label, t.label >= 1000 ? 0 : 2)}
          </span>
        ))}
        {g.last ? (
          <span className="last-tag" style={{ top: pctY(g.last.y) }}>
            {num(g.last.price, 2)}
          </span>
        ) : null}
      </div>
      <div className="candles-x" aria-hidden="true">
        {g.xTicks.map((t) => (
          <span key={`${t.label}-${t.x}`} style={{ left: pctX(t.x) }}>
            {t.label}
          </span>
        ))}
      </div>
    </div>
  );
}
