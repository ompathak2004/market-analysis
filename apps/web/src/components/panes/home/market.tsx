import { Chip, Sym } from "@/components/ui/chip";
import { DataTable } from "@/components/ui/data-table";
import { Empty } from "@/components/ui/empty";
import { Chg, Num } from "@/components/ui/num";
import { Pane } from "@/components/ui/pane";
import { getContext } from "@/server/context";
import { marketOverview, movers } from "@/server/queries";
import { asOf, attempt, PaneError } from "../shared";

const REGION_GROUP: Record<string, string> = {
  IN: "INDIA",
  US: "AMERICAS",
  UK: "EUROPE",
  DE: "EUROPE",
  JP: "ASIA-PACIFIC",
  HK: "ASIA-PACIFIC",
  CN: "ASIA-PACIFIC",
  FX: "FX & COMMODITIES",
  CMD: "FX & COMMODITIES",
  RATES: "FX & COMMODITIES",
};
const GROUP_ORDER = ["INDIA", "AMERICAS", "EUROPE", "ASIA-PACIFIC", "FX & COMMODITIES"];

type IndexRow = Awaited<ReturnType<typeof marketOverview>>["indices"][number];

export async function IndicesPane() {
  const res = await attempt(marketOverview(getContext()));
  if (!res.ok)
    return (
      <PaneError id="indices" title="WORLD INDICES" area="indices" code={res.code} source="Yahoo" />
    );
  const rows = res.data.indices;
  const groups = GROUP_ORDER.map((g) => ({
    label: g,
    rows: rows.filter((r) => REGION_GROUP[r.region] === g),
  })).filter((g) => g.rows.length);
  const live = rows.filter((r) => r.price != null).length;
  return (
    <Pane
      id="indices"
      title="WORLD INDICES"
      area="indices"
      meta={`${live}/${rows.length}`}
      foot={
        <>
          <output>NSE · Yahoo</output>
          <span className="right">as of {asOf(res.data.asOf)}</span>
        </>
      }
    >
      <DataTable<IndexRow>
        label="World indices"
        groups={groups}
        rowKey={(r) => r.symbol}
        columns={[
          {
            key: "name",
            header: "INDEX",
            cell: (r) => (
              <span className="truncate">
                <span className={r.marketState === "REGULAR" ? "pos" : "muted"} aria-hidden="true">
                  ●{" "}
                </span>
                {r.name}
              </span>
            ),
            title: (r) => `${r.symbol} · ${r.marketState ?? "unknown"}`,
          },
          {
            key: "last",
            header: "LAST",
            width: "num",
            align: "right",
            sortable: true,
            sortValue: (r) => r.price,
            cell: (r) => <Num v={r.price} />,
          },
          {
            key: "chg",
            header: "CHG%",
            width: "pct",
            align: "right",
            sortable: true,
            sortValue: (r) => r.changePct,
            cell: (r) => <Chg v={r.changePct} />,
          },
        ]}
        empty={<Empty title="No quotes">Yahoo returned no index quotes.</Empty>}
      />
    </Pane>
  );
}

type MoverRow = NonNullable<Awaited<ReturnType<typeof movers>>>["gainers"][number];

export async function MoversPane({ limit = 6 }: { limit?: number }) {
  const res = await attempt(movers(getContext(), 60));
  if (!res.ok || !res.data)
    return (
      <PaneError
        id="movers"
        title="NIFTY 50 MOVERS"
        area="movers"
        code={res.ok ? "EMPTY" : res.code}
        source="prices_daily"
      />
    );
  const all = res.data.gainers;
  const adv = all.filter((r) => r.changePct > 0).length;
  const dec = all.filter((r) => r.changePct < 0).length;
  const columns = [
    {
      key: "sym",
      header: "SYMBOL",
      cell: (r: MoverRow) => <Sym symbol={r.symbol} />,
      title: (r: MoverRow) => r.name,
    },
    {
      key: "last",
      header: "LAST",
      width: "num" as const,
      align: "right" as const,
      sortable: true,
      sortValue: (r: MoverRow) => Number(r.close),
      cell: (r: MoverRow) => <Num v={r.close} />,
    },
    {
      key: "chg",
      header: "CHG%",
      width: "pct" as const,
      align: "right" as const,
      sortable: true,
      sortValue: (r: MoverRow) => r.changePct,
      cell: (r: MoverRow) => <Chg v={r.changePct} />,
    },
  ];
  return (
    <Pane
      id="movers"
      title="NIFTY 50 MOVERS"
      area="movers"
      meta={res.data.date ? asOf(res.data.date) : "no session"}
      actions={<Chip href="/movers">MOV →</Chip>}
      foot={
        <>
          <output>
            <span className="pos">{adv} adv</span> · <span className="neg">{dec} dec</span>
          </output>
          <span className="right">close-to-close · prices_daily</span>
        </>
      }
    >
      <DataTable<MoverRow>
        label="NIFTY 50 movers"
        groups={[
          {
            label: <span className="pos">GAINERS</span>,
            rows: all.filter((r) => r.changePct > 0).slice(0, limit),
          },
          {
            label: <span className="neg">LOSERS</span>,
            rows: all
              .filter((r) => r.changePct < 0)
              .reverse()
              .slice(0, limit),
          },
        ]}
        rowKey={(r, i) => `${r.symbol}-${i}`}
        rowLink={(r) => `/c/${encodeURIComponent(r.symbol)}/des`}
        columns={columns}
        empty={
          <Empty title="No closes yet" hint="pnpm job prices">
            Daily prices for NIFTY 50 constituents have not been ingested.
          </Empty>
        }
      />
      {all.length ? (
        <div className="pane-section">
          <div className="dist" role="img" aria-label={`${adv} advancing, ${dec} declining`}>
            <span data-k="b" style={{ width: `${(adv / Math.max(1, adv + dec)) * 100}%` }} />
            <span data-k="s" style={{ width: `${(dec / Math.max(1, adv + dec)) * 100}%` }} />
          </div>
        </div>
      ) : null}
    </Pane>
  );
}
