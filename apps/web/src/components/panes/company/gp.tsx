import type { YahooRange } from "@ma/ingest";
import { Suspense } from "react";
import { Candles } from "@/components/ui/candles";
import { Chip } from "@/components/ui/chip";
import { Empty } from "@/components/ui/empty";
import { KeyValue } from "@/components/ui/key-value";
import { Chg } from "@/components/ui/num";
import { Pane, PaneSkeleton } from "@/components/ui/pane";
import { Sparkline } from "@/components/ui/sparkline";
import { normalizeBars, pickInterval } from "@/lib/chart";
import { compact, num, pct, shortDate } from "@/lib/format";
import { getContext } from "@/server/context";
import { priceHistory } from "@/server/queries";
import { rangeStats } from "@/server/queries/ui";
import { attempt, PaneError } from "../shared";

export const RANGES = ["1mo", "3mo", "6mo", "1y", "2y", "5y", "max"] as const;
export type ChartRange = (typeof RANGES)[number];
const RANGE_LABEL: Record<ChartRange, string> = {
  "1mo": "1M",
  "3mo": "3M",
  "6mo": "6M",
  "1y": "1Y",
  "2y": "2Y",
  "5y": "5Y",
  max: "MAX",
};
const SMA_SOURCE: Record<ChartRange, YahooRange> = {
  "1mo": "1y",
  "3mo": "1y",
  "6mo": "2y",
  "1y": "2y",
  "2y": "5y",
  "5y": "max",
  max: "max",
};

export function parseRange(v: string | string[] | undefined): ChartRange {
  const s = Array.isArray(v) ? v[0] : v;
  return (RANGES as readonly string[]).includes(s ?? "") ? (s as ChartRange) : "1y";
}

export async function ChartPane({ symbol, range }: { symbol: string; range: ChartRange }) {
  const ctx = getContext();
  const [main, hist] = await Promise.all([
    attempt(priceHistory(ctx, symbol, range)),
    attempt(priceHistory(ctx, symbol, SMA_SOURCE[range])),
  ]);
  if (!main.ok) return <PaneError id="chart" title="PRICE" area="chart" code={main.code} />;
  const bars = normalizeBars(main.data ?? []);
  const history = hist.ok ? normalizeBars(hist.data ?? []) : bars;
  const interval = pickInterval(bars.length);
  const base = `/c/${encodeURIComponent(symbol)}/gp`;
  const readoutId = `ohlc-${symbol}`;
  const last = bars.at(-1);
  return (
    <Pane
      id="chart"
      title="PRICE"
      area="chart"
      meta={`${RANGE_LABEL[range]} · ${interval === "1d" ? "daily" : interval === "1w" ? "weekly" : "monthly"} candles`}
      hints="[ ] range · hover for OHLCV · z zoom"
      actions={
        <fieldset className="chipset" data-range-chips>
          <legend className="sr-only">Chart range</legend>
          {RANGES.map((r) => (
            <Chip key={r} href={`${base}?range=${r}`} active={r === range}>
              {RANGE_LABEL[r]}
            </Chip>
          ))}
        </fieldset>
      }
      tabs={
        <span className="chart-legend">
          <span className="sma50">SMA {interval === "1d" ? 50 : interval === "1w" ? 10 : 3}</span>
          <span className="sma200">
            SMA {interval === "1d" ? 200 : interval === "1w" ? 40 : 10}
          </span>
          <span className="dim">volume</span>
        </span>
      }
      foot={
        <>
          <output id={readoutId} aria-live="off">
            {last
              ? `${last.date}  O ${num(last.open)}  H ${num(last.high)}  L ${num(last.low)}  C ${num(last.close)}  V ${compact(last.volume)}`
              : ""}
          </output>
          <span className="right">NSE daily · prices_daily</span>
        </>
      }
    >
      {bars.length >= 2 ? (
        <Candles
          bars={bars}
          history={history}
          readoutId={readoutId}
          label={`${symbol} ${RANGE_LABEL[range]} price chart`}
        />
      ) : (
        <Empty title="No price history" hint="pnpm job prices">
          Daily bars for {symbol} have not been ingested for this range.
        </Empty>
      )}
    </Pane>
  );
}

export async function RangeStatsPane({ symbol }: { symbol: string }) {
  const ctx = getContext();
  const [r, h] = await Promise.all([
    attempt(rangeStats(ctx, symbol)),
    attempt(priceHistory(ctx, symbol, "1y")),
  ]);
  if (!r.ok) return <PaneError id="stats" title="RANGE STATS" area="stats" code={r.code} />;
  const s = r.data;
  const closes = h.ok ? normalizeBars(h.data ?? []).map((b) => b.close) : [];
  return (
    <Pane
      id="stats"
      title="RANGE STATS"
      area="stats"
      meta={s.lastDate ? shortDate(s.lastDate) : "—"}
      foot={<output>{s.bars} daily bars · close-to-close</output>}
    >
      <div className="pane-section">
        <h3>1Y trend</h3>
        <Sparkline values={closes} width={260} height={40} label={`${symbol} one year closes`} />
      </div>
      <KeyValue
        label="Range statistics"
        groups={[
          {
            title: "Returns",
            items: s.returns.map((x) => ({ label: x.label, value: <Chg v={x.pct} digits={1} /> })),
          },
          {
            title: "Range",
            items: [
              { label: "Last close", value: num(s.last) },
              { label: "52W high", value: num(s.high52) },
              { label: "52W low", value: num(s.low52) },
              { label: "From high", value: <Chg v={s.fromHighPct} digits={1} /> },
              { label: "From low", value: <Chg v={s.fromLowPct} digits={1} /> },
            ],
          },
          {
            title: "Trend & risk",
            items: [
              { label: "SMA 50", value: num(s.sma50) },
              { label: "SMA 200", value: num(s.sma200) },
              {
                label: "Price vs SMA 200",
                value: (
                  <Chg
                    v={s.last != null && s.sma200 ? ((s.last - s.sma200) / s.sma200) * 100 : null}
                    digits={1}
                  />
                ),
              },
              { label: "Volatility · ann.", value: pct(s.volatilityPct, 1, false) },
              { label: "Avg volume · 20D", value: compact(s.avgVolume20) },
            ],
          },
        ]}
      />
    </Pane>
  );
}

export function GpView({ symbol, range }: { symbol: string; range: ChartRange }) {
  return (
    <div className="grid grid-gp">
      <Suspense fallback={<PaneSkeleton id="chart" title="PRICE" area="chart" lines={16} />}>
        <ChartPane symbol={symbol} range={range} />
      </Suspense>
      <Suspense fallback={<PaneSkeleton id="stats" title="RANGE STATS" area="stats" />}>
        <RangeStatsPane symbol={symbol} />
      </Suspense>
    </div>
  );
}
