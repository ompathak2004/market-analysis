"use client";

import type { VizFormat, VizSpec } from "@ma/agent";
import { type ReactNode, useMemo, useState } from "react";

type Spec<K extends VizSpec["kind"]> = Extract<VizSpec, { kind: K }>;

const SERIES = 8;

export function fmt(v: number | string | null | undefined, f: VizFormat, compact = false): string {
  if (v == null || v === "") return "—";
  if (typeof v === "string") return v;
  if (!Number.isFinite(v)) return "—";
  switch (f) {
    case "inr": {
      const a = Math.abs(v);
      const s = v < 0 ? "-" : "";
      if (compact && a >= 1e7) return `${s}₹${(a / 1e7).toFixed(2)}Cr`;
      if (compact && a >= 1e5) return `${s}₹${(a / 1e5).toFixed(2)}L`;
      return `${s}₹${a.toLocaleString("en-IN", { maximumFractionDigits: a >= 1000 ? 0 : 2 })}`;
    }
    case "pct":
      return `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
    case "qty":
      return v.toLocaleString("en-IN", { maximumFractionDigits: 4 });
    case "num":
      return Math.abs(v) >= 1000
        ? v.toLocaleString("en-IN", { maximumFractionDigits: 0 })
        : v.toLocaleString("en-IN", { maximumFractionDigits: 3 });
    default:
      return String(v);
  }
}

function Frame({ spec, children, wide }: { spec: VizSpec; children: ReactNode; wide?: boolean }) {
  return (
    <figure className="viz" data-kind={spec.kind} data-wide={wide ? "true" : undefined}>
      <figcaption className="viz-head">
        <span className="viz-title">{spec.title}</span>
        {spec.asOf ? <span className="viz-asof">as of {spec.asOf.slice(0, 10)}</span> : null}
      </figcaption>
      <div className="viz-body">{children}</div>
      <footer className="viz-foot">
        <span>{spec.source}</span>
        {spec.notes.map((n) => (
          <span key={n} className="viz-note">
            {n}
          </span>
        ))}
      </footer>
    </figure>
  );
}

function Kpis({ spec }: { spec: Spec<"kpis"> }) {
  return (
    <Frame spec={spec} wide>
      <dl className="viz-kpis">
        {spec.items.map((i) => (
          <div key={i.label} className="viz-kpi">
            <dt>{i.label}</dt>
            <dd data-tone={i.tone ?? undefined}>{fmt(i.value, i.format)}</dd>
          </div>
        ))}
      </dl>
    </Frame>
  );
}

function Donut({ spec }: { spec: Spec<"donut"> }) {
  const [hover, setHover] = useState<number | null>(null);
  const total = spec.slices.reduce((s, x) => s + x.value, 0) || 1;
  const r = 52;
  const c = 2 * Math.PI * r;
  let offset = 0;
  return (
    <Frame spec={spec}>
      <div className="viz-donut">
        <svg
          viewBox="0 0 140 140"
          role="img"
          aria-label={`${spec.title}: ${spec.slices.map((s) => `${s.label} ${((s.value / total) * 100).toFixed(1)}%`).join(", ")}`}
        >
          <g transform="rotate(-90 70 70)">
            {spec.slices.map((s, i) => {
              const len = (s.value / total) * c;
              const el = (
                <circle
                  aria-label={`${s.label} ${((s.value / total) * 100).toFixed(1)}%`}
                  key={s.label}
                  cx="70"
                  cy="70"
                  r={r}
                  fill="none"
                  strokeWidth={hover === i ? 22 : 18}
                  stroke={`var(--viz-${(i % SERIES) + 1})`}
                  strokeDasharray={`${len} ${c - len}`}
                  strokeDashoffset={-offset}
                  opacity={hover == null || hover === i ? 1 : 0.35}
                >
                  <title>{`${s.label}: ${fmt(s.value, spec.unit)} (${((s.value / total) * 100).toFixed(1)}%)`}</title>
                </circle>
              );
              offset += len;
              return el;
            })}
          </g>
          <text x="70" y="66" className="viz-donut-k">
            {hover == null ? "TOTAL" : (spec.slices[hover]?.label ?? "").slice(0, 14).toUpperCase()}
          </text>
          <text x="70" y="82" className="viz-donut-v">
            {hover == null
              ? fmt(total, spec.unit, true)
              : `${(((spec.slices[hover]?.value ?? 0) / total) * 100).toFixed(1)}%`}
          </text>
        </svg>
        <ul className="viz-legend">
          {spec.slices.map((s, i) => (
            <li key={s.label} data-active={hover === i ? "true" : undefined}>
              <button
                type="button"
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
              >
                <i style={{ background: `var(--viz-${(i % SERIES) + 1})` }} />
                <span className="truncate">{s.label}</span>
                <b>{((s.value / total) * 100).toFixed(1)}%</b>
                <em>{fmt(s.value, spec.unit, true)}</em>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </Frame>
  );
}

function Bars({ spec }: { spec: Spec<"bar"> }) {
  const hasCompare = spec.bars.some((b) => b.compare != null);
  const values = spec.bars.flatMap((b) => [b.value, b.compare ?? 0]);
  const max = Math.max(0, ...values);
  const min = Math.min(0, ...values);
  const span = max - min || 1;
  const zero = (-min / span) * 100;
  const pos = (v: number) => ({
    left: `${Math.min(zero, ((v - min) / span) * 100)}%`,
    width: `${Math.max(0.8, (Math.abs(v) / span) * 100)}%`,
  });
  const ticks = [min, min + span / 2, max];
  return (
    <Frame spec={spec}>
      {hasCompare ? (
        <div className="viz-bars-legend">
          <span>
            <i data-series="a" /> {spec.valueLabel ?? "Value"}
          </span>
          <span>
            <i data-series="b" /> {spec.compareLabel ?? "Compare"}
          </span>
        </div>
      ) : null}
      <ul
        className="viz-bars"
        data-grouped={hasCompare ? "true" : undefined}
        aria-label={spec.title}
      >
        {spec.bars.map((b, i) => (
          <li
            key={`${b.label}-${String(i)}`}
            title={`${b.label}: ${spec.valueLabel ?? "value"} ${fmt(b.value, spec.unit)}${b.compare != null ? ` · ${spec.compareLabel ?? "compare"} ${fmt(b.compare, spec.unit)}` : ""}`}
          >
            <span className="viz-bar-label truncate">{b.label}</span>
            <span className="viz-bar-area">
              <span className="viz-bar-grid" style={{ left: "50%" }} />
              {min < 0 ? <span className="viz-bar-zero" style={{ left: `${zero}%` }} /> : null}
              <span className="viz-bar-row">
                <span
                  className="viz-bar-fill"
                  data-tone={b.tone ?? undefined}
                  style={pos(b.value)}
                />
              </span>
              {hasCompare ? (
                <span className="viz-bar-row" data-series="b">
                  {b.compare != null ? (
                    <span className="viz-bar-compare" style={pos(b.compare)} />
                  ) : null}
                </span>
              ) : null}
            </span>
            <span className="viz-bar-value">
              <b data-tone={b.tone === "pos" || b.tone === "neg" ? b.tone : undefined}>
                {fmt(b.value, spec.unit, true)}
              </b>
              {hasCompare ? (
                <em>{b.compare != null ? fmt(b.compare, spec.unit, true) : "—"}</em>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
      <div className="viz-bars-axis" aria-hidden="true">
        <span />
        <span className="viz-bars-ticks">
          {ticks.map((t, i) => (
            <span key={String(i)}>{fmt(t, spec.unit, true)}</span>
          ))}
        </span>
        <span />
      </div>
    </Frame>
  );
}

const W = 600;
const H = 220;
const PAD = { l: 52, r: 12, t: 10, b: 22 };

function Line({ spec }: { spec: Spec<"line"> }) {
  const [hover, setHover] = useState<number | null>(null);
  const geo = useMemo(() => {
    const dates = [...new Set(spec.series.flatMap((s) => s.points.map((p) => p.x)))].sort();
    const idx = new Map(dates.map((d, i) => [d, i]));
    const ys = spec.series.flatMap((s) => s.points.map((p) => p.y));
    const lo = Math.min(...ys);
    const hi = Math.max(...ys);
    const pad = (hi - lo || Math.abs(hi) || 1) * 0.06;
    const y0 = lo - pad;
    const y1 = hi + pad;
    const x = (i: number) =>
      PAD.l + (dates.length > 1 ? (i / (dates.length - 1)) * (W - PAD.l - PAD.r) : 0);
    const y = (v: number) => PAD.t + ((y1 - v) / (y1 - y0)) * (H - PAD.t - PAD.b);
    const paths = spec.series.map((s) =>
      s.points
        .map((p, i) => `${i ? "L" : "M"}${x(idx.get(p.x) ?? 0).toFixed(1)} ${y(p.y).toFixed(1)}`)
        .join(""),
    );
    const ticks = Array.from({ length: 5 }, (_, i) => y0 + ((y1 - y0) * i) / 4);
    const lookup = spec.series.map((s) => new Map(s.points.map((p) => [p.x, p.y])));
    return { dates, x, y, paths, ticks, lookup };
  }, [spec]);
  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const n = geo.dates.length;
    const i = Math.round(((px - PAD.l) / (W - PAD.l - PAD.r)) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, i)));
  };
  const hd = hover == null ? null : geo.dates[hover];
  const every = Math.max(1, Math.ceil(geo.dates.length / 6));
  return (
    <Frame spec={spec} wide>
      <div className="viz-line-legend">
        {spec.series.map((s, i) => (
          <span key={s.name}>
            <i style={{ background: `var(--viz-${(i % SERIES) + 1})` }} />
            {s.name}
            {hd ? <b>{fmt(geo.lookup[i]?.get(hd) ?? null, spec.unit, true)}</b> : null}
          </span>
        ))}
        {hd ? <span className="viz-line-date">{hd}</span> : null}
      </div>
      <svg
        className="viz-line"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`${spec.title}: ${spec.series.map((s) => `${s.name} from ${fmt(s.points[0]?.y, spec.unit)} on ${s.points[0]?.x} to ${fmt(s.points.at(-1)?.y, spec.unit)} on ${s.points.at(-1)?.x}`).join("; ")}`}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        {geo.ticks.map((t) => (
          <g key={t}>
            <line className="grid-line" x1={PAD.l} x2={W - PAD.r} y1={geo.y(t)} y2={geo.y(t)} />
            <text className="axis-label" x={PAD.l - 6} y={geo.y(t) + 3} textAnchor="end">
              {fmt(t, spec.unit, true)}
            </text>
          </g>
        ))}
        {geo.dates.map((d, i) =>
          i % every === 0 || i === geo.dates.length - 1 ? (
            <text key={d} className="axis-label" x={geo.x(i)} y={H - 6} textAnchor="middle">
              {d.slice(2)}
            </text>
          ) : null,
        )}
        {geo.paths.map((d, i) => (
          <path
            key={spec.series[i]?.name}
            d={d}
            fill="none"
            stroke={`var(--viz-${(i % SERIES) + 1})`}
            strokeWidth="1.6"
          />
        ))}
        {hover != null ? (
          <line
            className="viz-cross"
            x1={geo.x(hover)}
            x2={geo.x(hover)}
            y1={PAD.t}
            y2={H - PAD.b}
          />
        ) : null}
      </svg>
    </Frame>
  );
}

function Table({ spec }: { spec: Spec<"table"> }) {
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);
  const rows = useMemo(() => {
    if (!sort) return spec.rows;
    return [...spec.rows].sort((a, b) => {
      const x = a[sort.key] ?? null;
      const y = b[sort.key] ?? null;
      if (x === y) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      return (x > y ? 1 : -1) * sort.dir;
    });
  }, [spec.rows, sort]);
  return (
    <Frame spec={spec} wide>
      <div className="viz-table scroll">
        <table className="dt">
          <thead>
            <tr>
              {spec.columns.map((c) => (
                <th
                  key={c.key}
                  data-num={c.format !== "text" && c.format !== "date" ? "true" : undefined}
                  aria-sort={
                    sort?.key === c.key ? (sort.dir === 1 ? "ascending" : "descending") : "none"
                  }
                >
                  <button
                    type="button"
                    onClick={() =>
                      setSort((s) => ({
                        key: c.key,
                        dir: s?.key === c.key && s.dir === -1 ? 1 : -1,
                      }))
                    }
                  >
                    {c.label}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={String(i)}>
                {spec.columns.map((c) => {
                  const v = r[c.key] ?? null;
                  const tone =
                    c.tone && typeof v === "number"
                      ? v > 0
                        ? "pos"
                        : v < 0
                          ? "neg"
                          : undefined
                      : undefined;
                  return (
                    <td
                      key={c.key}
                      data-num={c.format !== "text" && c.format !== "date" ? "true" : undefined}
                      data-tone={tone}
                    >
                      {fmt(v, c.format)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Frame>
  );
}

function Timeline({ spec, onSource }: { spec: Spec<"timeline">; onSource?: (id: string) => void }) {
  return (
    <Frame spec={spec} wide>
      <ol className="viz-timeline">
        {spec.events.map((e, i) => (
          <li key={`${e.date}-${String(i)}`} data-tone={e.tone ?? undefined}>
            <time>{e.date}</time>
            {e.tag ? <span className="badge">{e.tag}</span> : null}
            <span className="viz-timeline-label">{e.label}</span>
            {e.sourceId ? (
              <button
                type="button"
                className="cite"
                onClick={() => onSource?.(e.sourceId as string)}
              >
                {e.sourceId}
              </button>
            ) : null}
          </li>
        ))}
      </ol>
    </Frame>
  );
}

const NET_W = 680;
const NET_ROW = 30;
const NET_MAX_ROWS = 12;
const ROLE_COLUMN: Record<string, number> = { supplier: 0, center: 1, customer: 2 };

function Network({ spec }: { spec: Spec<"network"> }) {
  const layout = useMemo(() => {
    const center = spec.nodes.find((n) => n.role === "center") ?? spec.nodes[0];
    const sided = spec.nodes.some((n) => n.role === "supplier" || n.role === "customer");
    const column = new Map<string, number>();
    if (sided) {
      for (const n of spec.nodes) column.set(n.id, ROLE_COLUMN[n.role] ?? 2);
    } else {
      if (center) column.set(center.id, 0);
      for (let d = 0; d < 3; d++)
        for (const e of spec.edges) {
          const a = column.get(e.from);
          const b = column.get(e.to);
          if (a === d && b == null) column.set(e.to, d + 1);
          if (b === d && a == null) column.set(e.from, d + 1);
        }
      for (const n of spec.nodes) if (!column.has(n.id)) column.set(n.id, 2);
    }
    const used = [...new Set(column.values())].sort((a, b) => a - b);
    const cols = used.map((c) => spec.nodes.filter((n) => column.get(n.id) === c));
    const hidden = cols.map((c) => Math.max(0, c.length - NET_MAX_ROWS));
    const shown = cols.map((c) => c.slice(0, NET_MAX_ROWS));
    const rows = Math.max(1, ...shown.map((c, i) => c.length + ((hidden[i] ?? 0) > 0 ? 1 : 0)));
    const height = Math.max(120, rows * NET_ROW + 24);
    const pad = 96;
    const colX = (i: number) =>
      shown.length === 1 ? NET_W / 2 : pad + (i * (NET_W - pad * 2)) / (shown.length - 1);
    const pos = new Map<string, { x: number; y: number; w: number }>();
    shown.forEach((nodes, ci) => {
      const total = nodes.length + ((hidden[ci] ?? 0) > 0 ? 1 : 0);
      const top = (height - total * NET_ROW) / 2 + NET_ROW / 2;
      nodes.forEach((n, ri) => {
        const w = Math.min(176, Math.max(56, n.label.length * 6.6 + 18));
        pos.set(n.id, { x: colX(ci), y: top + ri * NET_ROW, w });
      });
    });
    const more = shown
      .map((nodes, ci) => ({
        ci,
        count: hidden[ci] ?? 0,
        x: colX(ci),
        y: (height - (nodes.length + 1) * NET_ROW) / 2 + NET_ROW / 2 + nodes.length * NET_ROW,
      }))
      .filter((m) => m.count > 0);
    return { pos, height, more };
  }, [spec]);
  return (
    <Frame spec={spec} wide>
      <div className="viz-network-legend">
        {(["supplier", "center", "customer", "holding", "event"] as const)
          .filter((r) => spec.nodes.some((n) => n.role === r))
          .map((r) => (
            <span key={r} data-role={r}>
              <i /> {r === "center" ? spec.center : r}
            </span>
          ))}
      </div>
      <svg
        className="viz-network"
        viewBox={`0 0 ${NET_W} ${layout.height}`}
        role="img"
        aria-label={`${spec.title}: ${spec.edges.map((e) => `${e.from} to ${e.to}${e.label ? ` (${e.label})` : ""}`).join("; ")}`}
      >
        {spec.edges.map((e, i) => {
          const a = layout.pos.get(e.from);
          const b = layout.pos.get(e.to);
          if (!a || !b) return null;
          const [l, r] = a.x <= b.x ? [a, b] : [b, a];
          const x1 = l.x + l.w / 2;
          const x2 = r.x - r.w / 2;
          const mx = (x1 + x2) / 2;
          const role = spec.nodes.find(
            (n) => (n.id === e.from || n.id === e.to) && n.role !== "center",
          )?.role;
          return (
            <g key={`${e.from}-${e.to}-${String(i)}`} className="viz-edge" data-role={role}>
              <path d={`M${x1} ${l.y} C${mx} ${l.y} ${mx} ${r.y} ${x2} ${r.y}`} />
              {e.label ? (
                <text x={mx} y={(l.y + r.y) / 2 - 4} textAnchor="middle">
                  {e.label.slice(0, 14)}
                </text>
              ) : null}
              {e.label ? <title>{e.label}</title> : null}
            </g>
          );
        })}
        {spec.nodes.map((n) => {
          const p = layout.pos.get(n.id);
          if (!p) return null;
          return (
            <g
              key={n.id}
              transform={`translate(${p.x} ${p.y})`}
              className="viz-node"
              data-role={n.role}
            >
              <rect x={-p.w / 2} y={-10} width={p.w} height={20} rx={2} />
              <text y={4} textAnchor="middle">
                {n.label.length > 24 ? `${n.label.slice(0, 23)}…` : n.label}
              </text>
              <title>{n.label}</title>
            </g>
          );
        })}
        {layout.more.map((m) => (
          <text key={m.ci} x={m.x} y={m.y + 4} textAnchor="middle" className="viz-node-more">
            +{m.count} more
          </text>
        ))}
      </svg>
    </Frame>
  );
}

export function Viz({ spec, onSource }: { spec: VizSpec; onSource?: (id: string) => void }) {
  switch (spec.kind) {
    case "kpis":
      return <Kpis spec={spec} />;
    case "donut":
      return <Donut spec={spec} />;
    case "bar":
      return <Bars spec={spec} />;
    case "line":
      return <Line spec={spec} />;
    case "table":
      return <Table spec={spec} />;
    case "timeline":
      return <Timeline spec={spec} {...(onSource ? { onSource } : {})} />;
    case "network":
      return <Network spec={spec} />;
    default:
      return null;
  }
}
