import type { RuleGroup, RuleInsight } from "@ma/intel";
import { Suspense } from "react";
import { Callout, CalloutGroup } from "@/components/ui/callout";
import { Sym } from "@/components/ui/chip";
import { DataTable } from "@/components/ui/data-table";
import { Empty } from "@/components/ui/empty";
import { KeyValue } from "@/components/ui/key-value";
import { Chg, Num } from "@/components/ui/num";
import { Pane, PaneSkeleton } from "@/components/ui/pane";
import { compact, compactInr, fyLabel, num, pct } from "@/lib/format";
import { getContext } from "@/server/context";
import { companyBrief, keyStats, type Peer, peers, rangeStats } from "@/server/queries";
import { attempt, PaneError } from "../shared";
import { BriefPane, RULE_TONE } from "./brief";

const GROUP_TITLE: Record<RuleGroup, string> = {
  price: "Price",
  financials: "Financials",
  industry: "Industry",
  shareholding: "Shareholding",
  consensus: "Consensus",
  supply_chain: "Supply chain",
  alt_data: "Alt-data",
};
const GROUP_ORDER: RuleGroup[] = [
  "price",
  "financials",
  "industry",
  "shareholding",
  "consensus",
  "supply_chain",
  "alt_data",
];

export async function InsightsPane({ symbol }: { symbol: string }) {
  const res = await attempt(companyBrief(getContext(), symbol));
  if (!res.ok) return <PaneError id="insights" title="INSIGHTS" area="insights" code={res.code} />;
  const items = res.data.ruleInsights;
  return (
    <Pane
      id="insights"
      title="INSIGHTS"
      area="insights"
      meta={`${items.length} observations`}
      foot={
        <>
          <output>rules over prices, Screener, Moneycontrol, filings</output>
          <span className="right">✓ supportive · ✗ adverse</span>
        </>
      }
    >
      {items.length ? (
        GROUP_ORDER.map((g) => {
          const list = items.filter((i: RuleInsight) => i.group === g);
          if (!list.length) return null;
          return (
            <CalloutGroup key={g} title={GROUP_TITLE[g]} count={list.length}>
              {list.map((i) => (
                <Callout
                  key={i.id}
                  tone={RULE_TONE[i.tone]}
                  title={i.text}
                  meta={i.evidence.length ? i.evidence.join(" · ") : undefined}
                />
              ))}
            </CalloutGroup>
          );
        })
      ) : (
        <Empty title="No observations">
          Prices and fundamentals have not been ingested for this company.
        </Empty>
      )}
    </Pane>
  );
}

export async function KeyStatsPane({ symbol }: { symbol: string }) {
  const ctx = getContext();
  const [s, r] = await Promise.all([
    attempt(keyStats(ctx, symbol)),
    attempt(rangeStats(ctx, symbol)),
  ]);
  if (!s.ok) return <PaneError id="stats" title="KEY STATS" area="stats" code={s.code} />;
  const k = s.data;
  const range = r.ok ? r.data : null;
  const x = (v: number | null, d = 1) => (v != null ? `${num(v, d)}×` : "—");
  return (
    <Pane
      id="stats"
      title="KEY STATS"
      area="stats"
      meta={k.latestAnnual ? `${fyLabel(k.latestAnnual)} / TTM` : "—"}
      foot={<output>Screener · reported consolidated · ₹ Cr unless stated</output>}
    >
      <KeyValue
        label="Key statistics"
        groups={[
          {
            title: "Valuation",
            items: [
              { label: "Market cap", value: compactInr(k.marketCapCr) },
              { label: "P/E · TTM", value: x(k.peTtm) },
              { label: "P/B", value: x(k.pb, 2) },
            ],
          },
          {
            title: "Profitability",
            items: [
              { label: "Revenue · TTM", value: compactInr(k.revenueTtmCr) },
              { label: "Net profit · TTM", value: compactInr(k.netIncomeTtmCr) },
              { label: "ROE", value: pct(k.roePct, 1, false) },
              { label: "Operating margin", value: pct(k.opmPct, 1, false) },
              { label: "Net margin", value: pct(k.npmPct, 1, false) },
              { label: "Revenue growth · FY", value: <Chg v={k.revenueGrowthPct} digits={1} /> },
              { label: "Profit growth · FY", value: <Chg v={k.profitGrowthPct} digits={1} /> },
            ],
          },
          {
            title: "Balance sheet",
            items: [
              { label: "Debt / equity", value: x(k.debtToEquity, 2) },
              { label: "Interest cover", value: x(k.interestCover) },
            ],
          },
          {
            title: "Trading",
            items: [
              {
                label: "52W range",
                value: range ? `${num(range.low52)} — ${num(range.high52)}` : "—",
              },
              { label: "From 52W high", value: <Chg v={range?.fromHighPct ?? null} digits={1} /> },
              { label: "Avg volume · 20D", value: compact(range?.avgVolume20 ?? null) },
              { label: "Volatility · ann.", value: pct(range?.volatilityPct ?? null, 1, false) },
              {
                label: "Latest quarter",
                value: k.latestQuarter ? fyLabel(k.latestQuarter, true) : "—",
              },
            ],
          },
        ]}
      />
    </Pane>
  );
}

export async function PeersPane({ symbol }: { symbol: string }) {
  const res = await attempt(peers(getContext(), symbol, 12));
  if (!res.ok) return <PaneError id="peers" title="PEERS" area="peers" code={res.code} />;
  const rows = res.data;
  return (
    <Pane
      id="peers"
      title="PEERS"
      area="peers"
      meta={rows[0]?.industry ?? "same sector"}
      foot={<output>sector peers by market cap · last close · distress score</output>}
    >
      <DataTable<Peer>
        label="Peers"
        rows={rows}
        rowKey={(r) => r.symbol}
        rowLink={(r) => (r.self ? null : `/c/${encodeURIComponent(r.symbol)}/des`)}
        rowSelected={(r) => r.self}
        columns={[
          {
            key: "s",
            header: "SYMBOL",
            width: "sym",
            cell: (r) => <Sym symbol={r.symbol} />,
            title: (r) => r.name,
          },
          {
            key: "m",
            header: "MCAP",
            align: "right",
            sortable: true,
            sortValue: (r) => r.marketCapCr,
            cell: (r) => compactInr(r.marketCapCr),
          },
          {
            key: "c",
            header: "LAST",
            width: "num",
            align: "right",
            priority: 2,
            sortable: true,
            sortValue: (r) => r.close,
            cell: (r) => <Num v={r.close} />,
          },
          {
            key: "p",
            header: "1D",
            width: "pct",
            align: "right",
            sortable: true,
            sortValue: (r) => r.changePct,
            cell: (r) => <Chg v={r.changePct} />,
          },
          {
            key: "d",
            header: "DISTRESS",
            width: "sm",
            align: "right",
            priority: 3,
            sortable: true,
            sortValue: (r) => r.distress,
            cell: (r) => <Num v={r.distress} digits={2} />,
          },
        ]}
        empty={<Empty title="No peers">This company has no sector classification yet.</Empty>}
      />
    </Pane>
  );
}

export function DesView({ symbol }: { symbol: string }) {
  return (
    <div className="grid grid-des">
      <Suspense fallback={<PaneSkeleton id="brief" title="INTELLIGENCE BRIEF" area="brief" />}>
        <BriefPane symbol={symbol} />
      </Suspense>
      <Suspense fallback={<PaneSkeleton id="insights" title="INSIGHTS" area="insights" />}>
        <InsightsPane symbol={symbol} />
      </Suspense>
      <Suspense fallback={<PaneSkeleton id="stats" title="KEY STATS" area="stats" />}>
        <KeyStatsPane symbol={symbol} />
      </Suspense>
      <Suspense fallback={<PaneSkeleton id="peers" title="PEERS" area="peers" />}>
        <PeersPane symbol={symbol} />
      </Suspense>
    </div>
  );
}
