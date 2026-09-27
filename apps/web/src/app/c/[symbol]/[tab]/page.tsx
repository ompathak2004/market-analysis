import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  AnalystsTab,
  ChartTab,
  DescriptionTab,
  FinancialsTab,
  NewsTab,
  SupplyChainTab,
} from "@/components/company-tabs";
import { Chg } from "@/components/panels";
import { ApiError, getOverview } from "@/lib/api";
import { isTab, TAB_TITLE, TABS } from "@/lib/commands";
import { crore, num, tone } from "@/lib/format";

export const dynamic = "force-dynamic";

type Params = Promise<{ symbol: string; tab: string }>;
type Search = Promise<{ range?: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { symbol, tab } = await params;
  return { title: `${symbol.toUpperCase()} ${tab.toUpperCase()} · MA Terminal` };
}

export default async function CompanyPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: Search;
}) {
  const { symbol: rawSymbol, tab } = await params;
  const symbol = rawSymbol.toUpperCase();
  if (!isTab(tab)) notFound();

  let overview: Awaited<ReturnType<typeof getOverview>>;
  try {
    overview = await getOverview(symbol);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      return (
        <div className="panel">
          <div className="err">
            {symbol} is not in the tracked universe. Try <a href="/">HOME</a> or search with CTRL+K.
          </div>
        </div>
      );
    }
    throw err;
  }
  const { company, quote } = overview;
  const { range = "1y" } = await searchParams;

  return (
    <>
      <div className="hdr">
        <div>
          <h1>
            <span className="sym">{company.nseSymbol}</span>
            {company.name}
          </h1>
          <div className="meta">
            {[company.sector, company.industry].filter(Boolean).join(" · ") || "—"} · NSE
            {company.isin ? ` · ${company.isin}` : ""} · MCAP {crore(company.marketCapCr)}
          </div>
        </div>
        <div>
          <div className={`price ${tone(quote?.change)}`}>{quote ? num(quote.price) : "—"}</div>
          <div className="chg">
            {quote ? (
              <>
                <span className={tone(quote.change)}>
                  {quote.change != null
                    ? `${quote.change > 0 ? "+" : ""}${num(quote.change)}`
                    : "—"}
                </span>{" "}
                <Chg v={quote.changePct} />{" "}
                <span className="faint">
                  {quote.marketState === "REGULAR" ? "LIVE" : (quote.marketState ?? "")}
                </span>
              </>
            ) : (
              <span className="faint">no quote</span>
            )}
          </div>
        </div>
      </div>

      <nav className="tabs">
        {TABS.map((t, i) => (
          <a key={t} href={`/c/${symbol}/${t}`} className={`tab${t === tab ? " active" : ""}`}>
            <b>{i + 1}</b>
            {t} <span className="faint">{TAB_TITLE[t]}</span>
          </a>
        ))}
      </nav>

      {tab === "des" && <DescriptionTab overview={overview} />}
      {tab === "gp" && <ChartTab symbol={symbol} range={range} />}
      {tab === "fa" && <FinancialsTab symbol={symbol} />}
      {tab === "anr" && <AnalystsTab symbol={symbol} />}
      {tab === "splc" && <SupplyChainTab symbol={symbol} overview={overview} />}
      {tab === "news" && <NewsTab symbol={symbol} />}
    </>
  );
}
