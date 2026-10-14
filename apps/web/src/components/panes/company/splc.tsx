import { Suspense } from "react";
import { Badge, Ext, Sym } from "@/components/ui/chip";
import { type Column, DataTable } from "@/components/ui/data-table";
import { Empty } from "@/components/ui/empty";
import { Num } from "@/components/ui/num";
import { Pane, PaneSkeleton } from "@/components/ui/pane";
import {
  clampText,
  inputsSummary,
  istDateTime,
  num,
  pct,
  shortDate,
  signalLabel,
  signalValue,
  toNum,
} from "@/lib/format";
import {
  basisLabel,
  COST_BUCKET_LABEL,
  confidenceLabel,
  familyLabel,
  periodLabel,
  sourceLabel,
  VALUE_BASIS_TONE,
} from "@/lib/splc";
import { getContext } from "@/server/context";
import {
  type ChainSignal,
  type SupplyChainCoverage,
  type SupplyChainCoverageFamily,
  type SupplyChainEdge,
  supplyChain,
} from "@/server/queries";
import { attempt, PaneError } from "../shared";

type Side = "customer" | "supplier";

const METHOD_TONE: Record<string, "pos" | "info" | "warn"> = {
  disclosed: "pos",
  derived: "info",
  estimated: "warn",
};

const METHOD_LABEL: Record<string, string> = {
  disclosed: "DISC",
  derived: "DERIV",
  estimated: "EST",
};

function share(r: SupplyChainEdge, side: Side): number | null {
  const est = side === "customer" ? r.estimate?.supplierRevenuePct : r.estimate?.customerCostPct;
  if (est != null) return est;
  return side === "customer" && r.disclosedBy === "supplier" ? r.disclosedPct : null;
}

function rangeText(r: SupplyChainEdge): string | null {
  const e = r.estimate;
  if (!e || (e.lowCr == null && e.highCr == null)) return null;
  return `${e.lowCr == null ? "?" : num(e.lowCr, 0)}–${e.highCr == null ? "?" : num(e.highCr, 0)}`;
}

function EvidenceLine({ edge }: { edge: SupplyChainEdge }) {
  const ev = edge.evidence[0];
  if (!ev) return <span className="splc-ev neg">no evidence span</span>;
  return (
    <span className="splc-ev">
      <span className="splc-ev-quote">“{clampText(ev.quote, 160)}”</span>
      <span className="muted">
        {" "}
        {sourceLabel(ev.source)}
        {ev.page != null ? ` p.${ev.page}` : ""}
        {ev.publishedAt ? ` · ${shortDate(ev.publishedAt)}` : ""}
        {edge.evidence.length > 1 ? ` · +${edge.evidence.length - 1}` : ""}
      </span>{" "}
      <Ext href={ev.url}>DOC</Ext>
    </span>
  );
}

function ValueCell({ r }: { r: SupplyChainEdge }) {
  const v = r.estimate?.valueCr;
  if (v != null) return <Num v={v} digits={0} />;
  if (r.contractTotalCr != null)
    return (
      <span className="warn num" title="Contract total over its term, not annual flow">
        CT {num(r.contractTotalCr, 0)}
      </span>
    );
  return <span className="muted">—</span>;
}

function relColumns(side: Side): Column<SupplyChainEdge>[] {
  return [
    {
      key: "n",
      header: side === "customer" ? "CUSTOMER" : "SUPPLIER",
      cell: (r) => (
        <span className="row">
          {r.counterparty.symbol ? <Sym symbol={r.counterparty.symbol} tab="splc" /> : null}
          <span className="truncate">{r.counterparty.name}</span>
          {r.status === "expired" ? <Badge tone="neu">EXPIRED</Badge> : null}
        </span>
      ),
      title: (r) => `${r.counterparty.name} · ${r.counterparty.kind}`,
    },
    {
      key: "b",
      header: "BASIS",
      width: "md",
      cell: (r) => (
        <Badge tone={VALUE_BASIS_TONE[r.valueBasis] ?? "neu"}>{basisLabel(r.valueBasis)}</Badge>
      ),
      title: (r) => r.valueBasis.replace("_", " "),
    },
    {
      key: "v",
      header: "EST ₹CR",
      width: "num",
      align: "right",
      sortable: true,
      sortValue: (r) => r.estimate?.valueCr ?? null,
      cell: (r) => <ValueCell r={r} />,
      title: (r) => {
        const range = rangeText(r);
        const parts = [
          range ? `range ${range} Cr` : null,
          r.contractTotalCr != null ? `contract total ${num(r.contractTotalCr, 0)} Cr` : null,
          r.estimate ? `${r.estimate.method} · as of ${r.estimate.asOf}` : null,
        ].filter(Boolean);
        return parts.length ? parts.join(" · ") : null;
      },
    },
    {
      key: "r",
      header: "RANGE",
      width: "num",
      align: "right",
      priority: 3,
      cell: (r) => <span className="dim num">{rangeText(r) ?? "—"}</span>,
      title: (r) => {
        const range = rangeText(r);
        return range ? `${range} Cr` : null;
      },
    },
    {
      key: "p",
      header: side === "customer" ? "% REV" : "% COST",
      width: "pct",
      align: "right",
      sortable: true,
      sortValue: (r) => share(r, side),
      cell: (r) => {
        const v = share(r, side);
        return v == null ? "—" : pct(v, 1, false);
      },
    },
    {
      key: "k",
      header: "BUCKET",
      width: "xs",
      priority: 2,
      cell: (r) => COST_BUCKET_LABEL[r.costBucket] ?? r.costBucket,
    },
    {
      key: "fy",
      header: "PERIOD",
      width: "sm",
      priority: 2,
      cell: (r) => periodLabel(r.period),
      title: (r) =>
        r.lastDisclosedAt
          ? `last disclosed ${r.lastDisclosedAt}${r.validTo ? ` · valid to ${r.validTo}` : ""}`
          : null,
    },
    {
      key: "m",
      header: "METHOD",
      width: "sm",
      priority: 3,
      cell: (r) =>
        r.estimate ? (
          <Badge tone={METHOD_TONE[r.estimate.method] ?? "neu"}>
            {METHOD_LABEL[r.estimate.method] ?? r.estimate.method.toUpperCase()}
          </Badge>
        ) : (
          <span className="muted">—</span>
        ),
      title: (r) => r.estimate?.method ?? null,
    },
    {
      key: "c",
      header: "CONF",
      width: "xs",
      align: "right",
      priority: 2,
      sortable: true,
      sortValue: (r) => r.confidence,
      cell: (r) => confidenceLabel(r.confidence),
      title: (r) => `${r.observationCount} observation${r.observationCount === 1 ? "" : "s"}`,
    },
  ];
}

function EmptyChain({
  side,
  symbol,
  coverage,
}: {
  side: Side;
  symbol: string;
  coverage: SupplyChainCoverage;
}) {
  if (coverage.available === 0)
    return (
      <Empty
        title="NO FILINGS AVAILABLE"
        hint="order filings · annual reports · concalls · ratings"
      >
        No source documents are stored for {symbol} yet.
      </Empty>
    );
  if (coverage.read === 0)
    return (
      <Empty
        title="FILINGS NOT YET READ"
        hint={`${coverage.available} filing${coverage.available === 1 ? "" : "s"} queued`}
      >
        {symbol} has filings on record that the extractor has not read yet.
      </Empty>
    );
  return (
    <Empty
      title="NO SUPPORTED RELATIONSHIPS"
      hint={`read ${coverage.read} of ${coverage.available} filings`}
    >
      No evidence-cited {side}s were found in the filings read for {symbol}.
    </Empty>
  );
}

export async function RelationshipPane({ symbol, side }: { symbol: string; side: Side }) {
  const id = side === "customer" ? "customers" : "suppliers";
  const title = side === "customer" ? "CUSTOMERS" : "SUPPLIERS";
  const res = await attempt(supplyChain(getContext(), symbol));
  if (!res.ok) return <PaneError id={id} title={title} area={id} code={res.code} />;
  const chain = res.data;
  const rows = side === "customer" ? chain.customers : chain.suppliers;
  const total = side === "customer" ? chain.totals.customers : chain.totals.suppliers;
  const flow = rows.reduce((s, r) => s + (toNum(r.estimate?.valueCr) ?? 0), 0);
  const contracts = rows.filter((r) => r.estimate?.valueCr == null && r.contractTotalCr != null);
  return (
    <Pane
      id={id}
      title={title}
      area={id}
      meta={total > rows.length ? `${rows.length} of ${total} links` : `${total} links`}
      hints="j/k rows · ↵ open counterparty · ⇧↵ evidence · z zoom"
      foot={
        <>
          <output data-digest-out>
            {flow
              ? `Σ ₹${Math.round(flow).toLocaleString("en-IN")} Cr est. annual flow`
              : "evidence-cited disclosures"}
            {contracts.length
              ? ` · ${contracts.length} contract total${contracts.length === 1 ? "" : "s"} not summed`
              : ""}
          </output>
          <span className="right">disclosed · derived · estimated</span>
        </>
      }
    >
      <DataTable<SupplyChainEdge>
        label={title}
        rows={rows}
        rowKey={(r) => r.id}
        rowLink={(r) =>
          r.counterparty.symbol ? `/c/${encodeURIComponent(r.counterparty.symbol)}/splc` : null
        }
        rowExternal={(r) => r.evidence[0]?.url ?? null}
        rowDigest={(r) => {
          const ev = r.evidence[0];
          return ev ? clampText(`${ev.quote} — ${sourceLabel(ev.source)}`, 220) : null;
        }}
        rowSub={(r) => <EvidenceLine edge={r} />}
        rowClass={(r) => (r.status === "expired" ? "dim" : undefined)}
        columns={relColumns(side)}
        empty={<EmptyChain side={side} symbol={symbol} coverage={chain.coverage} />}
      />
    </Pane>
  );
}

export async function CoveragePane({ symbol }: { symbol: string }) {
  const res = await attempt(supplyChain(getContext(), symbol));
  if (!res.ok) return <PaneError id="coverage" title="COVERAGE" area="coverage" code={res.code} />;
  const c = res.data.coverage;
  return (
    <Pane
      id="coverage"
      title="COVERAGE"
      area="coverage"
      meta={`read ${c.read}/${c.available}`}
      hints="j/k rows · z zoom"
      foot={
        <output>
          {c.lastReadAt ? `last read ${istDateTime(c.lastReadAt)}` : "not read yet"}
          {c.graphRevision != null ? ` · graph r${c.graphRevision}` : ""}
          {c.extractorVersion != null ? ` · extractor v${c.extractorVersion}` : ""}
        </output>
      }
    >
      <DataTable<SupplyChainCoverageFamily>
        label="Filing coverage by source"
        rows={c.families}
        rowKey={(f) => f.family}
        columns={[
          { key: "f", header: "SOURCE", cell: (f) => familyLabel(f.family) },
          {
            key: "r",
            header: "READ",
            width: "num",
            align: "right",
            cell: (f) => (
              <span className={`num ${f.read < f.available ? "warn" : "pos"}`}>
                {f.read}/{f.available}
              </span>
            ),
          },
          {
            key: "p",
            header: "%",
            width: "pct",
            align: "right",
            priority: 2,
            cell: (f) => (f.available ? pct((f.read / f.available) * 100, 0, false) : "—"),
          },
          {
            key: "d",
            header: "LAST READ",
            width: "date",
            cell: (f) => (f.lastReadAt ? shortDate(f.lastReadAt) : "—"),
          },
        ]}
        empty={
          <Empty title="NO FILINGS AVAILABLE" hint="relationship sources are linked on ingest">
            No order filings, annual reports, concalls or rating rationales are linked to {symbol}.
          </Empty>
        }
      />
    </Pane>
  );
}

export async function ChainSignalsPane({ symbol }: { symbol: string }) {
  const res = await attempt(supplyChain(getContext(), symbol));
  if (!res.ok)
    return <PaneError id="signals" title="CHAIN SIGNALS" area="signals" code={res.code} />;
  const rows = res.data.signals;
  return (
    <Pane
      id="signals"
      title="CHAIN SIGNALS"
      area="signals"
      meta={rows.length ? `as of ${shortDate(rows[0]?.asOf)}` : "—"}
      actions={null}
      foot={<output>signals · customer/supplier momentum, concentration, distress</output>}
    >
      <DataTable<ChainSignal>
        label="Supply-chain signals"
        rows={rows}
        rowKey={(s) => s.kind}
        rowLink={(s) => `/signals?kind=${encodeURIComponent(s.kind)}`}
        columns={[
          { key: "k", header: "SIGNAL", width: "lg", cell: (s) => signalLabel(s.kind) },
          {
            key: "v",
            header: "VALUE",
            width: "num",
            align: "right",
            sortable: true,
            sortValue: (s) => toNum(s.value),
            cell: (s) => {
              const v = toNum(s.value);
              const cls =
                /momentum/.test(s.kind) && v != null ? (v > 0 ? "pos" : v < 0 ? "neg" : "") : "";
              return (
                <span className={`num ${cls}`}>{v == null ? "—" : signalValue(s.kind, v)}</span>
              );
            },
          },
          { key: "d", header: "AS OF", width: "date", priority: 2, cell: (s) => shortDate(s.asOf) },
          {
            key: "i",
            header: "INPUTS",
            priority: 2,
            cell: (s) => (
              <span className="dim truncate">
                {inputsSummary(s.kind, (s.inputs ?? {}) as Record<string, unknown>)}
              </span>
            ),
            title: (s) => inputsSummary(s.kind, (s.inputs ?? {}) as Record<string, unknown>),
          },
        ]}
        empty={
          <Empty title="No chain signals" hint="pnpm job intel">
            Signals compute once relationships and prices are loaded.
          </Empty>
        }
      />
    </Pane>
  );
}

export function SplcView({ symbol }: { symbol: string }) {
  return (
    <div className="grid grid-splc">
      <Suspense fallback={<PaneSkeleton id="customers" title="CUSTOMERS" area="customers" />}>
        <RelationshipPane symbol={symbol} side="customer" />
      </Suspense>
      <Suspense fallback={<PaneSkeleton id="suppliers" title="SUPPLIERS" area="suppliers" />}>
        <RelationshipPane symbol={symbol} side="supplier" />
      </Suspense>
      <Suspense fallback={<PaneSkeleton id="coverage" title="COVERAGE" area="coverage" />}>
        <CoveragePane symbol={symbol} />
      </Suspense>
      <Suspense fallback={<PaneSkeleton id="signals" title="CHAIN SIGNALS" area="signals" />}>
        <ChainSignalsPane symbol={symbol} />
      </Suspense>
    </div>
  );
}
