"use client";

import { type PointerEvent, useCallback, useRef, useState } from "react";

type Row = readonly [string, number, number, number, number, number];

const fmt = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 });
const vol = new Intl.NumberFormat("en-IN", { notation: "compact", maximumFractionDigits: 2 });

export function CandlesCrosshair({ bars, readoutId }: { bars: readonly Row[]; readoutId: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [idx, setIdx] = useState<number | null>(null);

  const write = useCallback(
    (i: number | null) => {
      const out = document.getElementById(readoutId);
      if (!out) return;
      const b = i == null ? bars.at(-1) : bars[i];
      if (!b) {
        out.textContent = "";
        return;
      }
      const prev = i == null ? bars.at(-2) : bars[i - 1];
      const chg = prev ? ((b[4] - prev[4]) / prev[4]) * 100 : null;
      out.textContent = `${b[0]}  O ${fmt.format(b[1])}  H ${fmt.format(b[2])}  L ${fmt.format(b[3])}  C ${fmt.format(b[4])}${chg != null ? `  ${chg >= 0 ? "+" : ""}${chg.toFixed(2)}%` : ""}  V ${vol.format(b[5])}`;
    },
    [bars, readoutId],
  );

  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const el = ref.current;
    if (!el || !bars.length) return;
    const rect = el.getBoundingClientRect();
    const i = Math.max(
      0,
      Math.min(bars.length - 1, Math.floor(((e.clientX - rect.left) / rect.width) * bars.length)),
    );
    setIdx(i);
    write(i);
  };

  const onLeave = () => {
    setIdx(null);
    write(null);
  };

  const left = idx == null ? null : `${((idx + 0.5) / bars.length) * 100}%`;
  return (
    <div
      ref={ref}
      className="chart-overlay"
      onPointerMove={onMove}
      onPointerLeave={onLeave}
      aria-hidden="true"
    >
      {left ? <div className="crosshair-v" style={{ left }} /> : null}
    </div>
  );
}
