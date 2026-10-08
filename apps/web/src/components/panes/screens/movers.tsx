import { Sym } from "@/components/ui/chip";
import { DataTable } from "@/components/ui/data-table";
import { Empty } from "@/components/ui/empty";
import { Chg, Num } from "@/components/ui/num";
import { Pane } from "@/components/ui/pane";
import { shortDate } from "@/lib/format";
import { getContext } from "@/server/context";
import { movers } from "@/server/queries";
import { attempt, PaneError } from "../shared";

type MoverRow = NonNullable<Awaited<ReturnType<typeof movers>>>["gainers"][number];

export async function MoversBoardPane({ side }: { side: "gainers" | "losers" }) {
  const id = side;
  const title = side === "gainers" ? "ADVANCERS" : "DECLINERS";
  const res = await attempt(movers(getContext(), 60));
  if (!res.ok) return <PaneError id={id} title={title} code={res.code} />;
  const all = res.data ? [...res.data.gainers, ...res.data.losers] : [];
  const uniq = [...new Map(all.map((r) => [r.symbol, r])).values()];
  const rows = (
    side === "gainers" ? uniq.filter((r) => r.changePct > 0) : uniq.filter((r) => r.changePct < 0)
  ).sort((a, b) => (side === "gainers" ? b.changePct - a.changePct : a.changePct - b.changePct));
  return (
    <Pane
      id={id}
      title={title}
      meta={`NIFTY 50 · ${res.data?.date ? shortDate(res.data.date) : "—"}`}
      foot={
        <>
          <output>close vs previous close · prices_daily</output>
          <span className="right">{rows.length} names</span>
        </>
      }
    >
      <DataTable<MoverRow>
        label={title}
        rows={rows}
        rowKey={(r) => r.symbol}
        rowLink={(r) => `/c/${encodeURIComponent(r.symbol)}/gp`}
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
            cell: (r) => <Sym symbol={r.symbol} tab="gp" />,
          },
          {
            key: "n",
            header: "NAME",
            priority: 2,
            cell: (r) => <span className="dim truncate">{r.name}</span>,
            title: (r) => r.name,
          },
          {
            key: "p",
            header: "PREV",
            width: "num",
            align: "right",
            priority: 3,
            cell: (r) => <Num v={r.prev} />,
          },
          {
            key: "c",
            header: "LAST",
            width: "num",
            align: "right",
            sortable: true,
            sortValue: (r) => Number(r.close),
            cell: (r) => <Num v={r.close} />,
          },
          {
            key: "ch",
            header: "CHG%",
            width: "pct",
            align: "right",
            sortable: true,
            sortValue: (r) => r.changePct,
            cell: (r) => <Chg v={r.changePct} />,
          },
        ]}
        empty={
          <Empty
            title={side === "gainers" ? "No advancers" : "No decliners"}
            hint="pnpm job prices"
          >
            Needs two recent daily closes per constituent.
          </Empty>
        }
      />
    </Pane>
  );
}
