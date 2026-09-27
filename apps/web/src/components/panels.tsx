import type { ReactNode } from "react";
import type { IndexQuote, LatestCall, LeaderboardRow, Mover } from "@/lib/api";
import {
  ACTION_LABEL,
  num,
  pct,
  ratingBucket,
  shortDate,
  signalLabel,
  signalValue,
  signed,
  tone,
} from "@/lib/format";

export function Panel({
  title,
  sub,
  children,
  id,
  style,
}: {
  title: string;
  sub?: ReactNode;
  children: ReactNode;
  id?: string;
  style?: React.CSSProperties;
}) {
  return (
    <section className="panel" id={id} style={style}>
      <div className="panel-head">
        {title}
        {sub && <span className="sub">{sub}</span>}
      </div>
      {children}
    </section>
  );
}

export function Empty({ children = "No data yet." }: { children?: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Chg({ v, digits = 2 }: { v: number | null | undefined; digits?: number }) {
  return <span className={tone(v)}>{pct(v, digits)}</span>;
}

export function WorldIndices({ indices }: { indices: IndexQuote[] }) {
  const regions = [...new Set(indices.map((i) => i.region))];
  return (
    <div className="panel-body tight">
      <table className="t">
        <thead>
          <tr>
            <th>Index</th>
            <th className="r">Last</th>
            <th className="r">Chg</th>
            <th className="r">Chg%</th>
          </tr>
        </thead>
        <tbody>
          {regions.map((region) => (
            <RegionRows
              key={region}
              region={region}
              rows={indices.filter((i) => i.region === region)}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RegionRows({ region, rows }: { region: string; rows: IndexQuote[] }) {
  return (
    <>
      <tr>
        <td colSpan={4} className="faint" style={{ paddingTop: 6 }}>
          {region.toUpperCase()}
        </td>
      </tr>
      {rows.map((r) => (
        <tr key={r.symbol}>
          <td>
            {r.name} <span className="faint">{r.marketState === "REGULAR" ? "●" : ""}</span>
          </td>
          <td className="r">{num(r.price, r.price != null && Math.abs(r.price) < 100 ? 3 : 2)}</td>
          <td className={`r ${tone(r.change)}`}>{signed(r.change, 2)}</td>
          <td className="r">
            <Chg v={r.changePct} />
          </td>
        </tr>
      ))}
    </>
  );
}

export function MoversTable({ rows, compact = false }: { rows: Mover[]; compact?: boolean }) {
  if (rows.length === 0) return <Empty />;
  return (
    <table className="t">
      <thead>
        <tr>
          <th>Symbol</th>
          {!compact && <th>Name</th>}
          <th className="r">Last</th>
          <th className="r">Chg%</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((m) => (
          <tr key={m.symbol}>
            <td>
              <a href={`/c/${m.symbol}/des`} className="amber" title={m.name}>
                {m.symbol}
              </a>
            </td>
            {!compact && (
              <td
                className="dim"
                style={{ maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis" }}
              >
                {m.name}
              </td>
            )}
            <td className="r">{num(m.close)}</td>
            <td className="r">
              <Chg v={m.changePct} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function LatestCallsTable({ calls }: { calls: LatestCall[] }) {
  if (calls.length === 0) return <Empty />;
  return (
    <table className="t">
      <thead>
        <tr>
          <th>Date</th>
          <th>Symbol</th>
          <th>Firm</th>
          <th>Action</th>
          <th>Rating</th>
          <th className="r">Target</th>
        </tr>
      </thead>
      <tbody>
        {calls.map((c) => (
          <tr key={`${c.symbol}-${c.broker}-${c.publishedAt}-${c.targetPrice}`}>
            <td className="dim">{shortDate(c.publishedAt)}</td>
            <td>
              <a href={`/c/${c.symbol}/anr`} className="amber">
                {c.symbol}
              </a>
            </td>
            <td style={{ maxWidth: 150, overflow: "hidden", textOverflow: "ellipsis" }}>
              {c.broker}
            </td>
            <td className={actionTone(c.action)}>{ACTION_LABEL[c.action] ?? c.action}</td>
            <td>
              <span className={bucketTone(ratingBucket(c.rating))}>{c.rating}</span>
            </td>
            <td className="r">
              {c.reportUrl ? (
                <a
                  href={c.reportUrl}
                  target="_blank"
                  rel="noreferrer"
                  title={`prior ${num(c.priorTargetPrice)}`}
                >
                  {num(c.targetPrice)}
                </a>
              ) : (
                num(c.targetPrice)
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function actionTone(action: string): string {
  if (action === "upgrade" || action === "raise_target") return "up";
  if (action === "downgrade" || action === "lower_target") return "down";
  if (action === "initiate") return "cyan";
  return "dim";
}

export function bucketTone(b: string): string {
  if (b === "SB" || b === "B") return "up";
  if (b === "S") return "down";
  return "";
}

export function Leaderboard({
  kind,
  rows,
  compact = false,
}: {
  kind: string;
  rows: LeaderboardRow[];
  compact?: boolean;
}) {
  if (rows.length === 0) return <Empty />;
  const max = Math.max(...rows.map((r) => Math.abs(r.value)), 1e-9);
  return (
    <table className="t">
      <thead>
        <tr>
          <th>Symbol</th>
          {!compact && <th>Sector</th>}
          <th className="r">{compact ? "Value" : signalLabel(kind)}</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.symbol}>
            <td>
              <a href={`/c/${r.symbol}/splc`} className="amber">
                {r.symbol}
              </a>
            </td>
            {!compact && (
              <td
                className="dim"
                style={{ maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis" }}
              >
                {r.sector ?? "—"}
              </td>
            )}
            <td className={`r ${/momentum/.test(kind) ? tone(r.value) : ""}`}>
              {signalValue(kind, r.value)}
            </td>
            <td style={{ width: compact ? 48 : 80 }}>
              <span
                className="bar"
                style={{
                  width: `${Math.round((Math.abs(r.value) / max) * (compact ? 40 : 72))}px`,
                }}
              />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
