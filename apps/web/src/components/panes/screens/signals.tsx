import { Chip, Sym } from "@/components/ui/chip";
import { DataTable } from "@/components/ui/data-table";
import { Empty } from "@/components/ui/empty";
import { Pane } from "@/components/ui/pane";
import { inputsSummary, shortDate, signalLabel, signalValue, toNum } from "@/lib/format";
import { getContext } from "@/server/context";
import { signalLeaderboard } from "@/server/queries";
import { attempt, PaneError } from "../shared";

export const SIGNAL_KINDS = [
  "distress_score",
  "customer_momentum_1m",
  "customer_momentum_3m",
  "supplier_momentum_3m",
  "top5_customers_pct",
  "customer_hhi",
  "customer_concentration_pct",
  "top10_customers_pct",
  "customer_momentum_2m",
  "supplier_momentum_1m",
] as const;

export const OVERVIEW_KINDS = SIGNAL_KINDS.slice(0, 6);

const SIGNAL_NOTE: Record<string, string> = {
  distress_score:
    "Composite of ROE, margin, leverage, interest cover and turnover. Higher is worse.",
  customer_momentum_1m: "Revenue-weighted 1-month price momentum of listed customers.",
  customer_momentum_2m: "Revenue-weighted 2-month price momentum of listed customers.",
  customer_momentum_3m: "Revenue-weighted 3-month price momentum of listed customers.",
  supplier_momentum_1m: "Cost-weighted 1-month price momentum of listed suppliers.",
  supplier_momentum_3m: "Cost-weighted 3-month price momentum of listed suppliers.",
  top5_customers_pct: "Share of revenue from the five largest disclosed customers.",
  top10_customers_pct: "Share of revenue from the ten largest disclosed customers.",
  customer_hhi: "Herfindahl index of customer revenue shares. 1.0 is a single customer.",
  customer_concentration_pct: "Share of revenue from customers above 10% of sales.",
};

export function signalNote(kind: string): string {
  return (
    SIGNAL_NOTE[kind] ?? "Computed by the intel job from relationships, fundamentals and prices."
  );
}

type RawRow = NonNullable<Awaited<ReturnType<typeof signalLeaderboard>>>[number];
type Row = RawRow & { symbol: string };

export async function LeaderboardPane({
  kind,
  limit,
  order,
  full = false,
}: {
  kind: string;
  limit: number;
  order: "asc" | "desc";
  full?: boolean;
}) {
  const id = full ? "board" : kind;
  const res = await attempt(signalLeaderboard(getContext(), kind, limit, order));
  if (!res.ok) return <PaneError id={id} title={signalLabel(kind)} code={res.code} />;
  const rows = (res.data ?? []).filter((r): r is Row => r.symbol != null);
  const href = (o: "asc" | "desc") =>
    `/signals?kind=${encodeURIComponent(kind)}${o === "asc" ? "&order=asc" : ""}`;
  return (
    <Pane
      id={id}
      title={signalLabel(kind)}
      meta={rows[0] ? `as of ${shortDate(rows[0].asOf)}` : "—"}
      actions={
        full ? (
          <fieldset className="chipset" data-range-chips>
            <legend className="sr-only">Order</legend>
            <Chip href={href("desc")} active={order === "desc"}>
              TOP
            </Chip>
            <Chip href={href("asc")} active={order === "asc"}>
              BOTTOM
            </Chip>
          </fieldset>
        ) : (
          <Chip href={href("desc")}>ALL →</Chip>
        )
      }
      foot={
        <>
          <output data-digest-out>{full ? signalNote(kind) : kind}</output>
          <span className="right">{rows.length} rows</span>
        </>
      }
    >
      <DataTable<Row>
        label={signalLabel(kind)}
        rows={rows}
        rowKey={(r) => r.symbol}
        rowLink={(r) => `/c/${encodeURIComponent(r.symbol)}/splc`}
        rowDigest={(r) => inputsSummary(kind, (r.inputs ?? {}) as Record<string, unknown>)}
        columns={[
          {
            key: "i",
            header: "#",
            width: "xs",
            align: "right",
            cell: (_r, i) => <span className="muted">{i + 1}</span>,
          },
          {
            key: "s",
            header: "SYMBOL",
            width: "sym",
            cell: (r) => <Sym symbol={r.symbol} tab="splc" />,
          },
          {
            key: "n",
            header: "NAME",
            priority: full ? 1 : 2,
            cell: (r) => <span className="truncate dim">{r.name}</span>,
            title: (r) => r.name,
          },
          ...(full
            ? [
                {
                  key: "sec",
                  header: "SECTOR",
                  width: "md" as const,
                  priority: 2 as const,
                  cell: (r: Row) => <span className="dim truncate">{r.sector ?? "—"}</span>,
                },
                {
                  key: "in",
                  header: "INPUTS",
                  priority: 3 as const,
                  cell: (r: Row) => (
                    <span className="dim truncate">
                      {inputsSummary(kind, (r.inputs ?? {}) as Record<string, unknown>)}
                    </span>
                  ),
                },
              ]
            : []),
          {
            key: "v",
            header: "VALUE",
            width: "num",
            align: "right",
            sortable: true,
            sortValue: (r) => toNum(r.value),
            cell: (r) => {
              const v = toNum(r.value);
              const cls =
                /momentum/.test(kind) && v != null ? (v > 0 ? "pos" : v < 0 ? "neg" : "") : "";
              return <span className={`num ${cls}`}>{v == null ? "—" : signalValue(kind, v)}</span>;
            },
          },
        ]}
        empty={
          <Empty title="No rows" hint="pnpm job intel">
            {signalLabel(kind)} has not been computed yet.
          </Empty>
        }
      />
    </Pane>
  );
}

export function KindIndexPane({ active }: { active: string }) {
  return (
    <Pane
      id="kinds"
      title="SIGNALS"
      meta={`${SIGNAL_KINDS.length} kinds`}
      hints="j/k kinds · ↵ open"
    >
      <ul className="callouts" data-rows>
        {SIGNAL_KINDS.map((k) => (
          <li
            key={k}
            className="callout"
            data-row=""
            data-href={`/signals?kind=${k}`}
            data-selected={k === active ? "true" : undefined}
            data-tone={k === active ? "info" : "neu"}
          >
            <span className="callout-title">{signalLabel(k)}</span>
            <span className="callout-body">{signalNote(k)}</span>
          </li>
        ))}
      </ul>
    </Pane>
  );
}
