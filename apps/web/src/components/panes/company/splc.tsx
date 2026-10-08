import { Suspense } from "react";
import { Badge, Sym } from "@/components/ui/chip";
import { type Column, DataTable } from "@/components/ui/data-table";
import { Empty } from "@/components/ui/empty";
import { Num } from "@/components/ui/num";
import { Pane, PaneSkeleton } from "@/components/ui/pane";
import {
  clampText,
  inputsSummary,
  pct,
  shortDate,
  signalLabel,
  signalValue,
  toNum,
} from "@/lib/format";
import { getContext } from "@/server/context";
import { supplyChain } from "@/server/queries";
import { attempt, PaneError } from "../shared";

type Chain = NonNullable<Awaited<ReturnType<typeof supplyChain>>>;
type Rel = Chain["customers"][number];
type Sig = Chain["signals"][number];

const METHOD_TONE: Record<string, "pos" | "info" | "warn"> = {
  disclosed: "pos",
  derived: "info",
  estimated: "warn",
};

function evidenceText(e: unknown): string | null {
  if (!e) return null;
  if (typeof e === "string") return e;
  if (Array.isArray(e)) return e.map(evidenceText).filter(Boolean).join(" · ") || null;
  if (typeof e === "object") {
    const o = e as Record<string, unknown>;
    const t = o.quote ?? o.text ?? o.excerpt ?? o.source ?? o.url;
    return typeof t === "string" ? t : null;
  }
  return null;
}

function relColumns(side: "customer" | "supplier"): Column<Rel>[] {
  return [
    {
      key: "n",
      header: side === "customer" ? "CUSTOMER" : "SUPPLIER",
      cell: (r) => (
        <span className="row">
          {r.counterpartySymbol ? <Sym symbol={r.counterpartySymbol} tab="splc" /> : null}
          <span className="truncate">{side === "customer" ? r.customerName : r.supplierName}</span>
        </span>
      ),
      title: (r) => (side === "customer" ? r.customerName : r.supplierName),
    },
    {
      key: "v",
      header: "VALUE ₹CR",
      width: "num",
      align: "right",
      sortable: true,
      sortValue: (r) => toNum(r.valueCr),
      cell: (r) => <Num v={r.valueCr} digits={0} />,
      title: (r) =>
        r.valueLowCr != null || r.valueHighCr != null
          ? `range ${r.valueLowCr ?? "?"} – ${r.valueHighCr ?? "?"} Cr`
          : null,
    },
    {
      key: "p",
      header: side === "customer" ? "% REV" : "% COST",
      width: "pct",
      align: "right",
      sortable: true,
      sortValue: (r) => toNum(side === "customer" ? r.supplierRevenuePct : r.customerCostPct),
      cell: (r) => {
        const v = toNum(
          side === "customer" ? r.supplierRevenuePct : (r.customerCostPct ?? r.disclosedPct),
        );
        return v == null ? "—" : pct(v, 1, false);
      },
    },
    {
      key: "m",
      header: "METHOD",
      width: "md",
      priority: 2,
      cell: (r) =>
        r.method ? (
          <Badge tone={METHOD_TONE[r.method] ?? "neu"}>{r.method.toUpperCase()}</Badge>
        ) : (
          <span className="muted">—</span>
        ),
    },
    {
      key: "c",
      header: "CONF",
      width: "xs",
      align: "right",
      priority: 2,
      sortable: true,
      sortValue: (r) => toNum(r.confidence),
      cell: (r) => {
        const c = toNum(r.confidence);
        return c == null ? "—" : `${Math.round(c * 100)}%`;
      },
    },
    {
      key: "fy",
      header: "FY",
      width: "xs",
      priority: 3,
      cell: (r) => r.fiscalYear ?? "—",
    },
  ];
}

export async function RelationshipPane({
  symbol,
  side,
}: {
  symbol: string;
  side: "customer" | "supplier";
}) {
  const id = side === "customer" ? "customers" : "suppliers";
  const title = side === "customer" ? "CUSTOMERS" : "SUPPLIERS";
  const res = await attempt(supplyChain(getContext(), symbol));
  if (!res.ok) return <PaneError id={id} title={title} area={id} code={res.code} />;
  const rows = (side === "customer" ? res.data?.customers : res.data?.suppliers) ?? [];
  const total = rows.reduce((s, r) => s + (toNum(r.valueCr) ?? 0), 0);
  return (
    <Pane
      id={id}
      title={title}
      area={id}
      meta={`${rows.length} links`}
      hints="j/k rows · ↵ open counterparty · z zoom"
      foot={
        <>
          <output data-digest-out>
            {total
              ? `Σ ₹${Math.round(total).toLocaleString("en-IN")} Cr estimated`
              : "related-party & annual-report disclosures"}
          </output>
          <span className="right">disclosed · derived · estimated</span>
        </>
      }
    >
      <DataTable<Rel>
        label={title}
        rows={rows}
        rowKey={(r) => r.id}
        rowLink={(r) =>
          r.counterpartySymbol ? `/c/${encodeURIComponent(r.counterpartySymbol)}/splc` : null
        }
        rowDigest={(r) => clampText(evidenceText(r.evidence), 220) || null}
        rowSub={(r) => {
          const t = evidenceText(r.evidence);
          return t ? clampText(t, 140) : null;
        }}
        columns={relColumns(side)}
        empty={
          <Empty title={`No ${side}s mapped`} hint="pnpm job relationships">
            {side === "customer" ? "Revenue" : "Cost"} relationships for {symbol} come from
            related-party disclosures and annual reports.
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
  const rows = res.data?.signals ?? [];
  return (
    <Pane
      id="signals"
      title="CHAIN SIGNALS"
      area="signals"
      meta={rows.length ? `as of ${shortDate(rows[0]?.asOf)}` : "—"}
      actions={null}
      foot={<output>signals · customer/supplier momentum, concentration, distress</output>}
    >
      <DataTable<Sig>
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
      <Suspense fallback={<PaneSkeleton id="signals" title="CHAIN SIGNALS" area="signals" />}>
        <ChainSignalsPane symbol={symbol} />
      </Suspense>
    </div>
  );
}
