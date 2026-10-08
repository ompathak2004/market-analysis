import Link from "next/link";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/chip";
import { Chg } from "@/components/ui/num";
import { MiniRange } from "@/components/ui/sparkline";
import { TAB_TITLE, TABS, type Tab } from "@/lib/commands";
import { compactInr, num, pct } from "@/lib/format";
import { getContext } from "@/server/context";
import { quoteView } from "@/server/queries";
import { asOf, attempt } from "../shared";

export async function QuoteHeader({ symbol }: { symbol: string }) {
  const res = await attempt(quoteView(getContext(), symbol));
  if (!res.ok)
    return (
      <EmptyQuoteHeader
        symbol={symbol}
        name="quote unavailable · retries on the next refresh"
        tag={<Badge tone="neg">DATA UNAVAILABLE · {res.code}</Badge>}
      />
    );
  const q = res.data;
  const fromHigh = q.price != null && q.high52 ? ((q.price - q.high52) / q.high52) * 100 : null;
  const live = q.source === "live" && q.marketState === "REGULAR";
  return (
    <header className="quote-header">
      <div className="quote-title">
        <h1>
          <span className="accent">{q.symbol}</span> IN EQUITY
        </h1>
        <span className="quote-name">
          {q.name}
          {q.sector ? ` · ${q.sector}` : ""}
          {q.industry ? ` · ${q.industry}` : ""}
        </span>
        <span className="quote-tags">
          <Badge tone={live ? "pos" : "neu"}>
            {live ? "LIVE" : q.source === "close" ? "LAST CLOSE" : "DELAYED"}
          </Badge>
          <Badge>NSE · INR</Badge>
          {q.isin ? <Badge>{q.isin}</Badge> : null}
        </span>
      </div>
      <div className="quote-band">
        <div className="quote-cell quote-price">
          <span className="px">{num(q.price)}</span>
          <span className="stack">
            <Chg v={q.change} pct={false} />
            <Chg v={q.changePct} />
          </span>
        </div>
        <div className="quote-cell">
          <span className="lbl">Day range</span>
          <span className="val">
            {num(q.dayLow)} — {num(q.dayHigh)}
          </span>
          <MiniRange
            low={q.dayLow}
            high={q.dayHigh}
            value={q.price}
            label="Price within day range"
          />
        </div>
        <div className="quote-cell">
          <span className="lbl">52-week range</span>
          <span className="val">
            {num(q.low52)} — {num(q.high52)}
          </span>
          <span className="sub">
            {fromHigh != null ? `${pct(Math.abs(fromHigh), 1, false)} below high` : "—"}
          </span>
        </div>
        <div className="quote-cell">
          <span className="lbl">Market cap</span>
          <span className="val">{compactInr(q.marketCapCr)}</span>
          <span className="sub">{q.sector ?? "—"}</span>
        </div>
        <div className="quote-cell">
          <span className="lbl">P/E · TTM</span>
          <span className="val">{q.peTtm != null ? `${num(q.peTtm, 1)}×` : "—"}</span>
          <span className="sub">Screener fundamentals</span>
        </div>
        <div className="quote-cell">
          <span className="lbl">As of</span>
          <span className="val">{asOf(q.asOf)}</span>
          <span className="sub">
            {q.source === "live" ? "Yahoo quote" : q.source === "close" ? "NSE close" : "no price"}
          </span>
        </div>
      </div>
    </header>
  );
}

function EmptyQuoteHeader({
  symbol,
  name,
  tag,
}: {
  symbol: string;
  name: string;
  tag?: ReactNode;
}) {
  return (
    <header className="quote-header">
      <div className="quote-title">
        <h1>
          <span className="accent">{symbol}</span> IN EQUITY
        </h1>
        <span className="quote-name">{name}</span>
        {tag ? <span className="quote-tags">{tag}</span> : null}
      </div>
      <div className="quote-band">
        <div className="quote-cell quote-price">
          <span className="px">—</span>
        </div>
        {["Day range", "52-week range", "Market cap", "P/E · TTM", "As of"].map((l) => (
          <div key={l} className="quote-cell">
            <span className="lbl">{l}</span>
            <span className="val">—</span>
            <span className="sub">&nbsp;</span>
          </div>
        ))}
      </div>
    </header>
  );
}

export function QuoteHeaderSkeleton({ symbol }: { symbol: string }) {
  return <EmptyQuoteHeader symbol={symbol} name="loading…" />;
}

export function TabStrip({ symbol, tab }: { symbol: string; tab: Tab }) {
  return (
    <nav className="tabstrip" aria-label="Company functions" data-company-tabs>
      {TABS.map((t, i) => (
        <Link
          key={t}
          href={`/c/${encodeURIComponent(symbol)}/${t}`}
          aria-current={t === tab ? "page" : undefined}
          data-tab-index={i + 1}
          title={TAB_TITLE[t]}
        >
          <kbd>{i + 1}</kbd>
          {t.toUpperCase()}
        </Link>
      ))}
      <span className="tab-desc">/ {TAB_TITLE[tab]}</span>
      <span className="tab-hint">{symbol} · NSE · [1-9] switch</span>
    </nav>
  );
}
