import type { Bar } from "@/lib/api";
import { num, pct, shortDate, tone } from "@/lib/format";

const W = 960;
const H = 300;
const PAD = { l: 40, r: 64, t: 12, b: 24 };
const VOL_H = 50;

export function PriceChart({ bars }: { bars: Bar[] }) {
  if (bars.length < 2) return <div className="empty">Not enough price history.</div>;
  const closes = bars.map((b) => b.close);
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const span = max - min || 1;
  const plotH = H - PAD.t - PAD.b - VOL_H;
  const x = (i: number) => PAD.l + (i / (bars.length - 1)) * (W - PAD.l - PAD.r);
  const y = (v: number) => PAD.t + (1 - (v - min) / span) * plotH;
  const path = closes
    .map((c, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(c).toFixed(1)}`)
    .join(" ");
  const area = `${path} L${x(bars.length - 1).toFixed(1)},${(PAD.t + plotH).toFixed(1)} L${x(0).toFixed(1)},${(PAD.t + plotH).toFixed(1)} Z`;
  const first = closes[0] ?? 0;
  const last = closes.at(-1) ?? 0;
  const chg = first ? ((last - first) / first) * 100 : null;
  const color = tone(chg) === "down" ? "var(--down)" : "var(--up)";
  const maxVol = Math.max(...bars.map((b) => b.volume ?? 0), 1);
  const volTop = H - PAD.b - VOL_H;
  const ticks = 4;
  const labelEvery = Math.max(1, Math.floor(bars.length / 6));

  return (
    <div>
      <div className="dim" style={{ display: "flex", gap: 16, padding: "4px 10px" }}>
        <span>
          O <b className="cyan">{num(bars[0]?.open ?? first)}</b>
        </span>
        <span>
          H <b className="cyan">{num(Math.max(...bars.map((b) => b.high ?? b.close)))}</b>
        </span>
        <span>
          L <b className="cyan">{num(Math.min(...bars.map((b) => b.low ?? b.close)))}</b>
        </span>
        <span>
          C <b className="cyan">{num(last)}</b>
        </span>
        <span>
          Period <b className={tone(chg)}>{pct(chg)}</b>
        </span>
        <span style={{ marginLeft: "auto" }}>
          {shortDate(bars[0]?.date)} → {shortDate(bars.at(-1)?.date)} · {bars.length} bars
        </span>
      </div>
      <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Price chart">
        <defs>
          <linearGradient id="fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor={color} stopOpacity="0.25" />
            <stop offset="1" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        {Array.from({ length: ticks + 1 }, (_, i) => {
          const v = min + (span * i) / ticks;
          return (
            <g key={v}>
              <line
                x1={PAD.l}
                x2={W - PAD.r}
                y1={y(v)}
                y2={y(v)}
                stroke="var(--border)"
                strokeDasharray="2 4"
              />
              <text
                x={W - PAD.r + 6}
                y={y(v) + 4}
                fill="var(--fg-dim)"
                fontSize="11"
                fontFamily="inherit"
              >
                {num(v)}
              </text>
            </g>
          );
        })}
        {bars.map((b, i) =>
          i % labelEvery === 0 ? (
            <text
              key={b.date}
              x={x(i)}
              y={H - 8}
              fill="var(--fg-dim)"
              fontSize="10"
              textAnchor="middle"
              fontFamily="inherit"
            >
              {shortDate(b.date)}
            </text>
          ) : null,
        )}
        {bars.map((b, i) => {
          const h = ((b.volume ?? 0) / maxVol) * VOL_H;
          const prev = bars[i - 1]?.close ?? b.close;
          return (
            <rect
              key={b.date}
              x={x(i) - 1}
              width={Math.max(1, (W - PAD.l - PAD.r) / bars.length - 1)}
              y={volTop + VOL_H - h}
              height={h}
              fill={b.close >= prev ? "var(--up)" : "var(--down)"}
              opacity="0.35"
            />
          );
        })}
        <path d={area} fill="url(#fill)" />
        <path d={path} fill="none" stroke={color} strokeWidth="1.5" />
        <line
          x1={PAD.l}
          x2={W - PAD.r}
          y1={y(last)}
          y2={y(last)}
          stroke={color}
          strokeDasharray="3 3"
          opacity="0.7"
        />
        <rect x={W - PAD.r + 2} y={y(last) - 8} width={PAD.r - 4} height="16" fill={color} />
        <text
          x={W - PAD.r + 6}
          y={y(last) + 4}
          fill="#000"
          fontSize="11"
          fontWeight="700"
          fontFamily="inherit"
        >
          {num(last)}
        </text>
      </svg>
    </div>
  );
}
