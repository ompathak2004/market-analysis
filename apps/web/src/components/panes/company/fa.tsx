import { Suspense } from "react";
import { Badge } from "@/components/ui/chip";
import { type Column, DataTable } from "@/components/ui/data-table";
import { Empty } from "@/components/ui/empty";
import { KeyValue } from "@/components/ui/key-value";
import { Chg } from "@/components/ui/num";
import { Pane, PaneSkeleton } from "@/components/ui/pane";
import { Sparkline } from "@/components/ui/sparkline";
import { fyLabel, num, pct, toNum } from "@/lib/format";
import { getContext } from "@/server/context";
import { financials } from "@/server/queries";
import { attempt, PaneError } from "../shared";

type Fin = NonNullable<Awaited<ReturnType<typeof financials>>>["annual"][number];
type FinKey =
  | "revenue"
  | "operatingProfit"
  | "interestExpense"
  | "pretaxIncome"
  | "netIncome"
  | "totalAssets"
  | "totalEquity"
  | "totalDebt"
  | "cashFromOps"
  | "capex";

interface Line {
  key: string;
  label: string;
  values: Array<number | null>;
  kind: "value" | "margin" | "group";
  strong?: boolean;
}

const v = (r: Fin | undefined, k: FinKey) => (r ? toNum(r[k]) : null);
const ratio = (a: number | null, b: number | null) => (a != null && b ? a / b : null);

function lines(rows: Fin[], quarterly: boolean): Line[] {
  const val = (key: FinKey, label: string, strong = false): Line => ({
    key,
    label,
    values: rows.map((r) => v(r, key)),
    kind: "value",
    strong,
  });
  const margin = (key: string, label: string, num: FinKey): Line => ({
    key,
    label,
    values: rows.map((r) => {
      const m = ratio(v(r, num), v(r, "revenue"));
      return m == null ? null : m * 100;
    }),
    kind: "margin",
  });
  const out: Line[] = [
    { key: "g-pl", label: "Profit & loss", values: [], kind: "group" },
    val("revenue", "Revenue", true),
    val("operatingProfit", "Operating profit"),
    margin("opm", "OPM %", "operatingProfit"),
    val("interestExpense", "Interest"),
    val("pretaxIncome", "Profit before tax"),
    val("netIncome", "Net profit", true),
    margin("npm", "NPM %", "netIncome"),
  ];
  if (!quarterly)
    out.push(
      { key: "g-bs", label: "Balance sheet & cash", values: [], kind: "group" },
      val("totalAssets", "Total assets"),
      val("totalEquity", "Equity"),
      val("totalDebt", "Debt"),
      val("cashFromOps", "Cash from ops", true),
      val("capex", "Capex"),
    );
  return out;
}

function StatementTable({ rows, quarterly }: { rows: Fin[]; quarterly: boolean }) {
  const data = lines(rows, quarterly);
  const lag = quarterly ? 4 : 1;
  const cols: Column<Line>[] = [
    {
      key: "l",
      header: quarterly ? "₹ CR · QUARTER" : "₹ CR · FY",
      width: "lg",
      cell: (l) => (l.kind === "group" ? <span className="muted">{l.label}</span> : l.label),
      className: "label",
    },
    ...rows.map(
      (r, i): Column<Line> => ({
        key: r.periodEnd,
        header: fyLabel(r.periodEnd, quarterly),
        align: "right",
        priority: i < rows.length - 4 ? 3 : i < rows.length - 2 ? 2 : 1,
        sortValue: (l) => l.values[i] ?? null,
        cell: (l) =>
          l.kind === "group"
            ? ""
            : l.kind === "margin"
              ? pct(l.values[i], 1, false)
              : num(l.values[i], 0),
      }),
    ),
    {
      key: "yoy",
      header: "YOY",
      width: "pct",
      align: "right",
      cell: (l) => {
        if (l.kind !== "value") return "";
        const a = l.values.at(-1) ?? null;
        const b = l.values.at(-1 - lag) ?? null;
        return <Chg v={a != null && b ? ((a - b) / Math.abs(b)) * 100 : null} digits={1} />;
      },
    },
  ];
  return (
    <DataTable<Line>
      label={quarterly ? "Quarterly results" : "Annual results"}
      rows={data}
      rowKey={(l) => l.key}
      rowClass={(l) => (l.kind === "group" ? "dt-group" : l.strong ? "dt-total" : undefined)}
      columns={cols}
    />
  );
}

interface Check {
  id: string;
  label: string;
  pass: boolean | null;
  value: string;
}

function checks(a: Fin[]): Check[] {
  const cur = a.at(-1);
  const prev = a.at(-2);
  const roa = (r: Fin | undefined) => ratio(v(r, "netIncome"), v(r, "totalAssets"));
  const lev = (r: Fin | undefined) => ratio(v(r, "totalDebt"), v(r, "totalAssets"));
  const cr = (r: Fin | undefined) =>
    r ? ratio(toNum(r.currentAssets), toNum(r.currentLiabilities)) : null;
  const gm = (r: Fin | undefined) =>
    r ? ratio((v(r, "revenue") ?? 0) - (toNum(r.cogs) ?? 0), v(r, "revenue")) : null;
  const at = (r: Fin | undefined) => ratio(v(r, "revenue"), v(r, "totalAssets"));
  const cmp = (x: number | null, y: number | null, up = true) =>
    x == null || y == null ? null : up ? x > y : x < y;
  const ni = v(cur, "netIncome");
  const cfo = v(cur, "cashFromOps");
  const ic = ratio(v(cur, "operatingProfit"), v(cur, "interestExpense"));
  const f = (x: number | null, d = 2) => (x == null ? "—" : num(x, d));
  return [
    { id: "ni", label: "Net profit positive", pass: ni == null ? null : ni > 0, value: f(ni, 0) },
    {
      id: "cfo",
      label: "Operating cash flow positive",
      pass: cfo == null ? null : cfo > 0,
      value: f(cfo, 0),
    },
    {
      id: "roa",
      label: "ROA improved",
      pass: cmp(roa(cur), roa(prev)),
      value: `${pct((roa(prev) ?? Number.NaN) * 100, 1, false)} → ${pct((roa(cur) ?? Number.NaN) * 100, 1, false)}`,
    },
    {
      id: "accr",
      label: "Cash from ops > net profit",
      pass: ni == null || cfo == null ? null : cfo > ni,
      value: ni && cfo != null ? `${num(cfo / ni, 2)}×` : "—",
    },
    {
      id: "lev",
      label: "Leverage fell",
      pass: cmp(lev(cur), lev(prev), false),
      value: `${f(lev(prev))} → ${f(lev(cur))}`,
    },
    {
      id: "cr",
      label: "Current ratio improved",
      pass: cmp(cr(cur), cr(prev)),
      value: `${f(cr(prev))} → ${f(cr(cur))}`,
    },
    {
      id: "gm",
      label: "Gross margin improved",
      pass: cmp(gm(cur), gm(prev)),
      value: `${pct((gm(prev) ?? Number.NaN) * 100, 1, false)} → ${pct((gm(cur) ?? Number.NaN) * 100, 1, false)}`,
    },
    {
      id: "at",
      label: "Asset turnover improved",
      pass: cmp(at(cur), at(prev)),
      value: `${f(at(prev))} → ${f(at(cur))}`,
    },
    {
      id: "ic",
      label: "Interest cover above 3×",
      pass: ic == null ? null : ic > 3,
      value: ic == null ? "—" : `${num(ic, 1)}×`,
    },
  ];
}

export async function StatementPane({ symbol, quarterly }: { symbol: string; quarterly: boolean }) {
  const id = quarterly ? "quarterly" : "annual";
  const title = quarterly ? "QUARTERLY RESULTS" : "ANNUAL RESULTS";
  const res = await attempt(financials(getContext(), symbol));
  if (!res.ok)
    return <PaneError id={id} title={title} area={id} code={res.code} source="Screener" />;
  const rows =
    (quarterly ? res.data?.quarterly : res.data?.annual)?.slice(quarterly ? -8 : -6) ?? [];
  return (
    <Pane
      id={id}
      title={title}
      area={id}
      meta={`${rows.length} periods`}
      foot={<output>Screener · consolidated · ₹ crore</output>}
    >
      {rows.length ? (
        <StatementTable rows={rows} quarterly={quarterly} />
      ) : (
        <Empty title="No statements" hint="pnpm job fundamentals">
          {quarterly ? "Quarterly" : "Annual"} results have not been ingested for {symbol}.
        </Empty>
      )}
    </Pane>
  );
}

export async function ChecksPane({ symbol }: { symbol: string }) {
  const res = await attempt(financials(getContext(), symbol));
  if (!res.ok)
    return <PaneError id="checks" title="QUALITY CHECKS" area="checks" code={res.code} />;
  const annual = res.data?.annual ?? [];
  const list = annual.length >= 2 ? checks(annual) : [];
  const score = list.filter((c) => c.pass).length;
  const known = list.filter((c) => c.pass != null).length;
  return (
    <Pane
      id="checks"
      title="QUALITY CHECKS"
      area="checks"
      meta={list.length ? `${score}/${known}` : "—"}
      actions={
        list.length ? (
          <Badge tone={score >= 7 ? "pos" : score <= 3 ? "neg" : "warn"}>SCORE {score}/9</Badge>
        ) : null
      }
      foot={<output>Piotroski-style · latest FY vs prior FY</output>}
    >
      {list.length ? (
        <DataTable<Check>
          label="Quality checks"
          rows={list}
          rowKey={(c) => c.id}
          columns={[
            { key: "c", header: "CHECK", cell: (c) => c.label },
            {
              key: "r",
              header: "RESULT",
              width: "sm",
              align: "center",
              sortValue: (c) => (c.pass == null ? -1 : c.pass ? 1 : 0),
              cell: (c) =>
                c.pass == null ? (
                  <span className="muted">n/a</span>
                ) : c.pass ? (
                  <span className="pos">✓ PASS</span>
                ) : (
                  <span className="neg">✗ FAIL</span>
                ),
            },
            { key: "v", header: "VALUE", width: "lg", align: "right", cell: (c) => c.value },
          ]}
        />
      ) : (
        <Empty title="Needs two fiscal years">
          Quality checks compare the latest two annual statements.
        </Empty>
      )}
    </Pane>
  );
}

export async function DupontPane({ symbol }: { symbol: string }) {
  const res = await attempt(financials(getContext(), symbol));
  if (!res.ok) return <PaneError id="dupont" title="DUPONT" area="dupont" code={res.code} />;
  const annual = (res.data?.annual ?? []).slice(-5);
  const rows = annual.map((r) => {
    const npm = ratio(v(r, "netIncome"), v(r, "revenue"));
    const at = ratio(v(r, "revenue"), v(r, "totalAssets"));
    const lev = ratio(v(r, "totalAssets"), v(r, "totalEquity"));
    return {
      fy: fyLabel(r.periodEnd),
      npm,
      at,
      lev,
      roe: npm != null && at != null && lev != null ? npm * at * lev : null,
    };
  });
  const last3 = rows.slice(-3);
  const series = (k: "npm" | "at" | "lev" | "roe") =>
    rows.map((r) => r[k]).filter((x): x is number => x != null);
  return (
    <Pane
      id="dupont"
      title="DUPONT"
      area="dupont"
      meta="ROE = margin × turnover × leverage"
      foot={<output>derived from annual statements</output>}
    >
      {rows.length ? (
        <>
          <KeyValue
            label="DuPont decomposition"
            groups={last3.map((r) => ({
              title: r.fy,
              items: [
                { label: "Net margin", value: pct(r.npm != null ? r.npm * 100 : null, 1, false) },
                { label: "Asset turnover", value: r.at != null ? `${num(r.at, 2)}×` : "—" },
                { label: "Leverage", value: r.lev != null ? `${num(r.lev, 2)}×` : "—" },
                { label: "ROE", value: <b>{pct(r.roe != null ? r.roe * 100 : null, 1, false)}</b> },
              ],
            }))}
          />
          <div className="pane-section">
            <h3>Trend · {rows.length} FY</h3>
            <div className="tiles">
              {(["roe", "npm", "at", "lev"] as const).map((k) => (
                <div key={k} className="tile">
                  <span className="lbl">
                    {{ roe: "ROE", npm: "Margin", at: "Turnover", lev: "Leverage" }[k]}
                  </span>
                  <Sparkline values={series(k)} width={100} height={18} label={`${k} trend`} />
                </div>
              ))}
            </div>
          </div>
        </>
      ) : (
        <Empty title="No annual statements">DuPont needs at least one fiscal year.</Empty>
      )}
    </Pane>
  );
}

export function FaView({ symbol }: { symbol: string }) {
  return (
    <div className="grid grid-fa">
      <Suspense fallback={<PaneSkeleton id="annual" title="ANNUAL RESULTS" area="annual" />}>
        <StatementPane symbol={symbol} quarterly={false} />
      </Suspense>
      <Suspense fallback={<PaneSkeleton id="checks" title="QUALITY CHECKS" area="checks" />}>
        <ChecksPane symbol={symbol} />
      </Suspense>
      <Suspense
        fallback={<PaneSkeleton id="quarterly" title="QUARTERLY RESULTS" area="quarterly" />}
      >
        <StatementPane symbol={symbol} quarterly />
      </Suspense>
      <Suspense fallback={<PaneSkeleton id="dupont" title="DUPONT" area="dupont" />}>
        <DupontPane symbol={symbol} />
      </Suspense>
    </div>
  );
}
