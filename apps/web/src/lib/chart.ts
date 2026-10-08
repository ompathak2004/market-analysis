export interface Bar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type BarInterval = "1d" | "1w" | "1mo";

export interface RawBar {
  date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number;
  volume: number | null;
}

export function normalizeBars(rows: readonly RawBar[]): Bar[] {
  return rows.map((r) => {
    const close = Number(r.close);
    const open = r.open != null ? Number(r.open) : close;
    return {
      date: String(r.date).slice(0, 10),
      open,
      high: r.high != null ? Number(r.high) : Math.max(open, close),
      low: r.low != null ? Number(r.low) : Math.min(open, close),
      close,
      volume: r.volume != null ? Number(r.volume) : 0,
    };
  });
}

function bucketKey(date: string, interval: BarInterval): string {
  if (interval === "1mo") return date.slice(0, 7);
  const d = new Date(`${date}T00:00:00Z`);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}

export function aggregate(bars: readonly Bar[], interval: BarInterval): Bar[] {
  if (interval === "1d") return [...bars];
  const out: Bar[] = [];
  let key = "";
  for (const b of bars) {
    const k = bucketKey(b.date, interval);
    const last = out.at(-1);
    if (last && k === key) {
      last.high = Math.max(last.high, b.high);
      last.low = Math.min(last.low, b.low);
      last.close = b.close;
      last.volume += b.volume;
      last.date = b.date;
    } else {
      key = k;
      out.push({ ...b });
    }
  }
  return out;
}

export function pickInterval(count: number): BarInterval {
  if (count <= 300) return "1d";
  if (count <= 1000) return "1w";
  return "1mo";
}

export function sma(values: readonly number[], n: number): Array<number | null> {
  const out: Array<number | null> = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i] as number;
    if (i >= n) sum -= values[i - n] as number;
    out.push(i >= n - 1 ? sum / n : null);
  }
  return out;
}

export const VIEW_W = 1000;
export const VIEW_H = 1000;
const PRICE_TOP = 20;
const PRICE_BOTTOM = 790;
const VOL_TOP = 830;
const VOL_BOTTOM = 1000;

export interface CandleGeom {
  x: number;
  w: number;
  yOpen: number;
  yClose: number;
  yHigh: number;
  yLow: number;
  up: boolean;
  volY: number;
}

export interface ChartGeom {
  interval: BarInterval;
  bars: Bar[];
  candles: CandleGeom[];
  sma50: string | null;
  sma200: string | null;
  yTicks: Array<{ y: number; label: number }>;
  xTicks: Array<{ x: number; label: string }>;
  last: { y: number; price: number } | null;
  slot: number;
  min: number;
  max: number;
}

function niceStep(range: number, target: number): number {
  const raw = range / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10;
  return step * mag;
}

function linePath(
  values: Array<number | null>,
  x: (i: number) => number,
  y: (v: number) => number,
) {
  let d = "";
  let pen = false;
  values.forEach((v, i) => {
    if (v == null) {
      pen = false;
      return;
    }
    d += `${pen ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`;
    pen = true;
  });
  return d || null;
}

const MONTH = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

export function buildChart(daily: readonly Bar[], smaSource: readonly Bar[] = daily): ChartGeom {
  const interval = pickInterval(daily.length);
  const bars = aggregate(daily, interval);
  const n = bars.length;
  const slot = n ? VIEW_W / n : VIEW_W;
  const lows = bars.map((b) => b.low);
  const highs = bars.map((b) => b.high);
  const rawMin = n ? Math.min(...lows) : 0;
  const rawMax = n ? Math.max(...highs) : 1;
  const pad = (rawMax - rawMin || rawMax || 1) * 0.04;
  const min = rawMin - pad;
  const max = rawMax + pad;
  const y = (v: number) => PRICE_TOP + ((max - v) / (max - min)) * (PRICE_BOTTOM - PRICE_TOP);
  const x = (i: number) => i * slot + slot / 2;
  const maxVol = Math.max(1, ...bars.map((b) => b.volume));
  const candles = bars.map((b, i) => ({
    x: x(i),
    w: Math.max(1, slot * 0.64),
    yOpen: y(b.open),
    yClose: y(b.close),
    yHigh: y(b.high),
    yLow: y(b.low),
    up: b.close >= b.open,
    volY: VOL_BOTTOM - (b.volume / maxVol) * (VOL_BOTTOM - VOL_TOP),
  }));

  const intervalSource = aggregate(smaSource, interval);
  const offset = intervalSource.length - n;
  const closes = intervalSource.map((b) => b.close);
  const smaWindow = interval === "1d" ? [50, 200] : interval === "1w" ? [10, 40] : [3, 10];
  const s50 = sma(closes, smaWindow[0] as number).slice(Math.max(0, offset));
  const s200 = sma(closes, smaWindow[1] as number).slice(Math.max(0, offset));

  const step = niceStep(rawMax - rawMin || 1, 6);
  const yTicks: ChartGeom["yTicks"] = [];
  for (let v = Math.ceil(min / step) * step; v <= max; v += step)
    yTicks.push({ y: y(v), label: v });

  const xTicks: ChartGeom["xTicks"] = [];
  const every = Math.max(1, Math.ceil(n / 7));
  for (let i = 0; i < n; i += every) {
    const d = bars[i]?.date ?? "";
    const m = MONTH[Number(d.slice(5, 7)) - 1] ?? "";
    xTicks.push({ x: x(i), label: `${m}'${d.slice(2, 4)}` });
  }

  const lastBar = bars.at(-1);
  return {
    interval,
    bars,
    candles,
    sma50: linePath(s50, x, y),
    sma200: linePath(s200, x, y),
    yTicks,
    xTicks,
    last: lastBar ? { y: y(lastBar.close), price: lastBar.close } : null,
    slot,
    min,
    max,
  };
}

export function sparkPath(values: readonly number[], w: number, h: number): string {
  if (values.length < 2) return "";
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;
  return values
    .map((v, i) => {
      const px = (i / (values.length - 1)) * w;
      const py = h - ((v - lo) / span) * h;
      return `${i ? "L" : "M"}${px.toFixed(1)} ${py.toFixed(1)}`;
    })
    .join("");
}

export function project(lat: number, lon: number, w: number, h: number) {
  return { x: ((lon + 180) / 360) * w, y: ((90 - lat) / 180) * h };
}
