import type { Fundamental, Overview, RelationshipRow } from "@/lib/api";
import {
  attempt,
  getAnalysts,
  getAnnouncements,
  getFinancials,
  getPrices,
  getSupplyChain,
} from "@/lib/api";
import {
  ACTION_LABEL,
  crore,
  fyLabel,
  inputsSummary,
  num,
  pct,
  ratingBucket,
  shortDate,
  signalLabel,
  signalValue,
  tone,
} from "@/lib/format";
import { PriceChart } from "./chart";
import { actionTone, bucketTone, Chg, Empty, Panel, Unavailable } from "./panels";

const RANGES = ["1mo", "3mo", "6mo", "1y", "2y", "5y", "max"];

function ratio(a: string | null | undefined, b: string | null | undefined): number | null {
  const x = Number(a);
  const y = Number(b);
  if (!a || !b || !Number.isFinite(x) || !Number.isFinite(y) || y === 0) return null;
  return x / y;
}

function ratioPct(a: string | null | undefined, b: string | null | undefined): number | null {
  const r = ratio(a, b);
  return r == null ? null : r * 100;
}

function growth(rows: Fundamental[], key: keyof Fundamental, lag = 1): number | null {
  const cur = rows[0];
  const prev = rows[lag];
  if (!cur || !prev) return null;
  const a = Number(cur[key]);
  const b = Number(prev[key]);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return null;
  return ((a - b) / Math.abs(b)) * 100;
}

export function DescriptionTab({ overview }: { overview: Overview }) {
  const { company, quote, latestAnnual: fa, latestQuarter: fq, signals } = overview;
  const mcap = Number(company.marketCapCr);
  const pe = fa?.netIncome && mcap ? mcap / Number(fa.netIncome) : null;
  const ps = fa?.revenue && mcap ? mcap / Number(fa.revenue) : null;
  const pb = fa?.totalEquity && mcap ? mcap / Number(fa.totalEquity) : null;
  return (
    <div className="grid grid-3">
      <Panel title="Key data" sub={fa ? `${fyLabel(fa.periodEnd)} annual · ₹ Cr` : ""}>
        <div className="panel-body kv">
          <div>
            <span>Last</span>
            <span>{quote ? num(quote.price) : "—"}</span>
          </div>
          <div>
            <span>Prev close</span>
            <span>{num(quote?.previousClose)}</span>
          </div>
          <div>
            <span>Market cap</span>
            <span>{crore(company.marketCapCr)}</span>
          </div>
          <div>
            <span>Revenue</span>
            <span>{crore(fa?.revenue)}</span>
          </div>
          <div>
            <span>EBIT / Op. profit</span>
            <span>{crore(fa?.operatingProfit)}</span>
          </div>
          <div>
            <span>Net income</span>
            <span>{crore(fa?.netIncome)}</span>
          </div>
          <div>
            <span>Op. margin</span>
            <span>{pct(ratioPct(fa?.operatingProfit, fa?.revenue), 1, false)}</span>
          </div>
          <div>
            <span>Net margin</span>
            <span>{pct(ratioPct(fa?.netIncome, fa?.revenue), 1, false)}</span>
          </div>
          <div>
            <span>ROE</span>
            <span>{pct(ratioPct(fa?.netIncome, fa?.totalEquity), 1, false)}</span>
          </div>
          <div>
            <span>Debt / Equity</span>
            <span>{num(ratio(fa?.totalDebt, fa?.totalEquity), 2)}</span>
          </div>
          <div>
            <span>P/E (trailing FY)</span>
            <span>{num(pe, 1)}</span>
          </div>
          <div>
            <span>P/S</span>
            <span>{num(ps, 2)}</span>
          </div>
          <div>
            <span>P/B</span>
            <span>{num(pb, 2)}</span>
          </div>
          <div>
            <span>Total debt</span>
            <span>{crore(fa?.totalDebt)}</span>
          </div>
          <div>
            <span>Cash from ops</span>
            <span>{crore(fa?.cashFromOps)}</span>
          </div>
          <div>
            <span>Latest quarter</span>
            <span>{fq ? `${fyLabel(fq.periodEnd, true)} · rev ${crore(fq.revenue)}` : "—"}</span>
          </div>
        </div>
      </Panel>
      <Panel title="Signals" sub="latest">
        <div className="panel-body tight">
          {signals.length === 0 ? (
            <Empty>No signals computed yet.</Empty>
          ) : (
            <table className="t">
              <tbody>
                {signals.map((s) => (
                  <tr key={s.kind}>
                    <td className="dim">{signalLabel(s.kind)}</td>
                    <td className={`r ${/momentum/.test(s.kind) ? tone(s.value) : ""}`}>
                      {signalValue(s.kind, s.value)}
                    </td>
                    <td className="r faint">{shortDate(s.asOf)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </Panel>
    </div>
  );
}

export async function ChartTab({ symbol, range }: { symbol: string; range: string }) {
  const r = RANGES.includes(range) ? range : "1y";
  const res = await attempt(getPrices(symbol, r));
  return (
    <Panel
      title="Price"
      sub={
        <span className="chart-ranges">
          {RANGES.map((x) => (
            <a key={x} href={`/c/${symbol}/gp?range=${x}`} className={x === r ? "active" : ""}>
              {x.toUpperCase()}
            </a>
          ))}
        </span>
      }
    >
      {res.ok ? <PriceChart bars={res.data.bars} /> : <Unavailable error={res.error} />}
    </Panel>
  );
}

const LINES: Array<[keyof Fundamental, string]> = [
  ["revenue", "Revenue"],
  ["cogs", "COGS"],
  ["sga", "SG&A"],
  ["operatingProfit", "Operating profit"],
  ["interestExpense", "Interest"],
  ["pretaxIncome", "Pre-tax income"],
  ["netIncome", "Net income"],
  ["cashFromOps", "Cash from ops"],
  ["capex", "Capex"],
  ["totalAssets", "Total assets"],
  ["totalEquity", "Total equity"],
  ["totalDebt", "Total debt"],
];

const QUARTERLY_LINES = new Set<keyof Fundamental>([
  "revenue",
  "cogs",
  "operatingProfit",
  "interestExpense",
  "pretaxIncome",
  "netIncome",
]);

function FinTable({ rows, quarterly = false }: { rows: Fundamental[]; quarterly?: boolean }) {
  if (rows.length === 0) return <Empty />;
  const cols = [...rows].sort((a, b) => (a.periodEnd < b.periodEnd ? 1 : -1)).slice(0, 8);
  const lines = quarterly ? LINES.filter(([key]) => QUARTERLY_LINES.has(key)) : LINES;
  const lag = quarterly ? 4 : 1;
  return (
    <div className="panel-body tight" style={{ overflowX: "auto" }}>
      <table className="t">
        <thead>
          <tr>
            <th>{quarterly ? "Quarter" : "Annual"} · ₹ Cr</th>
            {cols.map((c) => (
              <th key={c.periodEnd} className="r">
                {fyLabel(c.periodEnd, quarterly)}
              </th>
            ))}
            <th className="r">YoY</th>
          </tr>
        </thead>
        <tbody>
          {lines.map(([key, label]) => (
            <tr key={key}>
              <td className="dim">{label}</td>
              {cols.map((c) => (
                <td key={c.periodEnd} className="r">
                  {num(c[key] as string | null, 0)}
                </td>
              ))}
              <td className="r">
                <Chg v={growth(cols, key, lag)} digits={1} />
              </td>
            </tr>
          ))}
          <tr>
            <td className="dim">Op. margin</td>
            {cols.map((c) => (
              <td key={c.periodEnd} className="r">
                {pct(ratioPct(c.operatingProfit, c.revenue), 1, false)}
              </td>
            ))}
            <td />
          </tr>
          <tr>
            <td className="dim">Net margin</td>
            {cols.map((c) => (
              <td key={c.periodEnd} className="r">
                {pct(ratioPct(c.netIncome, c.revenue), 1, false)}
              </td>
            ))}
            <td />
          </tr>
        </tbody>
      </table>
    </div>
  );
}

export async function FinancialsTab({ symbol }: { symbol: string }) {
  const res = await attempt(getFinancials(symbol));
  return (
    <div className="grid">
      <Panel title="Annual" sub="Screener.in · consolidated where available">
        {res.ok ? <FinTable rows={res.data.annual} /> : <Unavailable error={res.error} />}
      </Panel>
      <Panel title="Quarterly" sub="last 8 quarters">
        {res.ok ? (
          <FinTable rows={res.data.quarterly} quarterly />
        ) : (
          <Unavailable error={res.error} />
        )}
      </Panel>
    </div>
  );
}

export async function AnalystsTab({ symbol }: { symbol: string }) {
  const res = await attempt(getAnalysts(symbol));
  if (!res.ok)
    return (
      <Panel title="Analyst recommendations">
        <Unavailable error={res.error} />
      </Panel>
    );
  const { summary: s, calls } = res.data;
  return (
    <Panel title="Analyst recommendations" sub={`${s.brokers} brokers · last 6 months · Trendlyne`}>
      <div className="summary">
        <div>
          <div className="lbl">Avg target</div>
          <div className="val amber">{num(s.avgTarget)}</div>
        </div>
        <div>
          <div className="lbl">Upside vs {num(s.price)}</div>
          <div className={`val ${tone(s.upsidePct)}`}>{pct(s.upsidePct, 1)}</div>
        </div>
        <div>
          <div className="lbl">Low / Med / High</div>
          <div className="val">
            {num(s.lowTarget, 0)} <span className="faint">/</span> {num(s.medianTarget, 0)}{" "}
            <span className="faint">/</span> {num(s.highTarget, 0)}
          </div>
        </div>
        <div>
          <div className="lbl">Ratings</div>
          <div className="val counts">
            <span>
              <b>SB</b> {s.counts.strongBuy}
            </span>
            <span>
              <b>B</b> {s.counts.buy}
            </span>
            <span>
              <b>H</b> {s.counts.hold}
            </span>
            <span>
              <b>S</b> {s.counts.sell}
            </span>
          </div>
        </div>
      </div>
      <div className="panel-body tight">
        {calls.length === 0 ? (
          <Empty>No broker calls captured for {symbol} yet.</Empty>
        ) : (
          <table className="t">
            <thead>
              <tr>
                <th>Date</th>
                <th>Firm</th>
                <th>Action</th>
                <th>Rating</th>
                <th className="r">Target</th>
                <th className="r">Prior</th>
                <th className="r">Px at call</th>
                <th className="r">Implied</th>
                <th>Report</th>
              </tr>
            </thead>
            <tbody>
              {calls.map((c) => {
                const implied =
                  c.targetPrice && c.priceAtCall
                    ? ((c.targetPrice - c.priceAtCall) / c.priceAtCall) * 100
                    : null;
                return (
                  <tr key={c.id}>
                    <td className="dim">{shortDate(c.publishedAt)}</td>
                    <td>{c.broker}</td>
                    <td className={actionTone(c.action)}>{ACTION_LABEL[c.action] ?? c.action}</td>
                    <td>
                      <span className={bucketTone(ratingBucket(c.rating))}>{c.rating}</span>
                      {c.priorRating && c.priorRating !== c.rating && (
                        <span className="faint"> ← {c.priorRating}</span>
                      )}
                    </td>
                    <td className="r">{num(c.targetPrice)}</td>
                    <td className="r dim">{num(c.priorTargetPrice)}</td>
                    <td className="r dim">{num(c.priceAtCall)}</td>
                    <td className="r">
                      <Chg v={implied} digits={1} />
                    </td>
                    <td>
                      {c.reportUrl ? (
                        <a href={c.reportUrl} target="_blank" rel="noreferrer">
                          open ↗
                        </a>
                      ) : (
                        <span className="faint">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </Panel>
  );
}

function RelTable({ rows, side }: { rows: RelationshipRow[]; side: "customer" | "supplier" }) {
  if (rows.length === 0) return <Empty>No {side}s extracted from filings yet.</Empty>;
  return (
    <table className="t">
      <thead>
        <tr>
          <th>{side}</th>
          <th>Method</th>
          <th className="r">Value ₹ Cr</th>
          <th className="r">Range</th>
          <th className="r">% supp. rev</th>
          <th className="r">% cust. cost</th>
          <th className="r">Conf.</th>
          <th>Source</th>
          <th>Evidence</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const name = side === "customer" ? r.customerName : r.supplierName;
          return (
            <tr key={r.id}>
              <td>
                {r.counterpartySymbol ? (
                  <a href={`/c/${r.counterpartySymbol}/splc`} className="amber">
                    {r.counterpartySymbol}
                  </a>
                ) : (
                  <span className="faint">—</span>
                )}{" "}
                <span className="wrap">{name}</span>
              </td>
              <td>
                {r.method ? (
                  <span className={`badge ${r.method}`}>{r.method}</span>
                ) : (
                  <span className="faint">—</span>
                )}
              </td>
              <td className="r">{num(r.valueCr, 0)}</td>
              <td className="r dim">
                {r.valueLowCr ? `${num(r.valueLowCr, 0)}–${num(r.valueHighCr, 0)}` : "—"}
              </td>
              <td className="r">{pct(r.supplierRevenuePct, 1, false)}</td>
              <td className="r">{pct(r.customerCostPct, 1, false)}</td>
              <td className="r">{r.confidence.toFixed(2)}</td>
              <td className="dim">
                {r.disclosureKind}
                {r.fiscalYear ? ` FY${String(r.fiscalYear).slice(2)}` : ""}
                {r.disclosedPct != null ? ` · ${r.disclosedPct}%` : ""}
              </td>
              <td className="evidence wrap">{r.evidence ?? ""}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export async function SupplyChainTab({ symbol, overview }: { symbol: string; overview: Overview }) {
  const res = await attempt(getSupplyChain(symbol));
  if (!res.ok)
    return (
      <Panel title="Supply chain">
        <Unavailable error={res.error} />
      </Panel>
    );
  const data = res.data;
  const revenue = overview.latestAnnual?.revenue;
  return (
    <div className="grid">
      <Panel title="Supply chain signals" sub="filings-derived · see methodology">
        <div className="panel-body tight">
          {data.signals.length === 0 ? (
            <Empty>No supply-chain signals yet. Run the relationships and intel jobs.</Empty>
          ) : (
            <table className="t">
              <thead>
                <tr>
                  <th>Signal</th>
                  <th className="r">Value</th>
                  <th>As of</th>
                  <th>Inputs</th>
                </tr>
              </thead>
              <tbody>
                {data.signals.map((s) => (
                  <tr key={s.kind}>
                    <td>{signalLabel(s.kind)}</td>
                    <td className={`r ${/momentum/.test(s.kind) ? tone(s.value) : ""}`}>
                      {signalValue(s.kind, s.value)}
                    </td>
                    <td className="dim">{shortDate(s.asOf)}</td>
                    <td className="faint wrap" style={{ maxWidth: 520 }}>
                      {inputsSummary(s.kind, s.inputs)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </Panel>
      <Panel title="Customers" sub={`${symbol} sells to · revenue base ${crore(revenue)}`}>
        <div className="panel-body tight">
          <RelTable rows={data.customers} side="customer" />
        </div>
      </Panel>
      <Panel title="Suppliers" sub={`${symbol} buys from`}>
        <div className="panel-body tight">
          <RelTable rows={data.suppliers} side="supplier" />
        </div>
      </Panel>
    </div>
  );
}

export async function NewsTab({ symbol }: { symbol: string }) {
  const res = await attempt(getAnnouncements(symbol));
  return (
    <Panel title="Corporate announcements" sub="NSE">
      <div className="panel-body tight">
        {!res.ok ? (
          <Unavailable error={res.error} />
        ) : res.data.items.length === 0 ? (
          <Empty>No announcements ingested for {symbol} yet.</Empty>
        ) : (
          <table className="t">
            <thead>
              <tr>
                <th>Date</th>
                <th>Subject</th>
                <th>Details</th>
                <th>File</th>
              </tr>
            </thead>
            <tbody>
              {res.data.items.map((a) => (
                <tr key={a.id}>
                  <td className="dim">{shortDate(a.publishedAt)}</td>
                  <td className="wrap" style={{ maxWidth: 260 }}>
                    {a.subject}
                  </td>
                  <td className="wrap dim" style={{ maxWidth: 600 }}>
                    {a.details}
                  </td>
                  <td>
                    {a.attachmentUrl ? (
                      <a href={a.attachmentUrl} target="_blank" rel="noreferrer">
                        PDF ↗
                      </a>
                    ) : (
                      ""
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Panel>
  );
}
