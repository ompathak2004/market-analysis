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
        {geo.dates.map((d, i) => {
          const last = geo.dates.length - 1;
          const show = i === last || (i % every === 0 && geo.x(last) - geo.x(i) >= 64);
          if (!show) return null;
          const anchor = i === last && last > 0 ? "end" : i === 0 ? "start" : "middle";
          return (
            <text key={d} className="axis-label" x={geo.x(i)} y={H - 6} textAnchor={anchor}>
              {d.slice(2)}
            </text>
          );
        })}
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

const NET_ROW = 30;
const NET_MAX_ROWS = 12;
const NET_MAX_CHARS = 24;
const NET_EDGE_CHARS = 16;
const NET_MARGIN = 8;
const ROLE_COLUMN: Record<string, number> = { supplier: 0, center: 1, customer: 2 };

const nodeText = (label: string) =>
  label.length > NET_MAX_CHARS ? `${label.slice(0, NET_MAX_CHARS - 1)}…` : label;
const nodeWidth = (label: string) => Math.max(48, nodeText(label).length * 6.4 + 16);
const edgeText = (label: string) =>
  label.length > NET_EDGE_CHARS ? `${label.slice(0, NET_EDGE_CHARS - 1)}…` : label;

function Network({ spec }: { spec: Spec<"network"> }) {
  const layout = useMemo(() => {
    const center = spec.nodes.find((n) => n.role === "center") ?? spec.nodes[0];
    const ids = new Set(spec.nodes.map((n) => n.id));
    const edges = spec.edges.filter((e) => ids.has(e.from) && ids.has(e.to) && e.from !== e.to);
    const sided =
      spec.nodes.some((n) => n.role === "supplier" || n.role === "customer") &&
      spec.nodes.every((n) => n.role in ROLE_COLUMN);
    const column = new Map<string, number>();
    if (sided) {
      for (const n of spec.nodes) column.set(n.id, ROLE_COLUMN[n.role] ?? 2);
    } else {
      if (center) column.set(center.id, 0);
      for (let d = 0; d < spec.nodes.length; d++) {
        let grew = false;
        for (const e of edges) {
          const a = column.get(e.from);
          const b = column.get(e.to);
          if (a === d && b == null) {
            column.set(e.to, d + 1);
            grew = true;
          }
          if (b === d && a == null) {
            column.set(e.from, d + 1);
            grew = true;
          }
        }
        if (!grew && ![...column.values()].some((c) => c > d)) break;
      }
      const deepest = Math.max(0, ...column.values());
      for (const n of spec.nodes) if (!column.has(n.id)) column.set(n.id, deepest + 1);
    }
    const used = [...new Set(column.values())].sort((a, b) => a - b);
    const cols = used.map((c) => spec.nodes.filter((n) => column.get(n.id) === c));
    const neighbours = new Map<string, string[]>();
    for (const e of edges) {
      neighbours.set(e.from, [...(neighbours.get(e.from) ?? []), e.to]);
      neighbours.set(e.to, [...(neighbours.get(e.to) ?? []), e.from]);
    }
    const shown: (typeof spec.nodes)[] = [];
    const hidden: number[] = [];
    cols.forEach((col, ci) => {
      const prev = new Map((shown[ci - 1] ?? []).map((n, i) => [n.id, i]));
      const rank = (id: string) => {
        const r = (neighbours.get(id) ?? [])
          .map((x) => prev.get(x))
          .filter((x): x is number => x != null);
        return r.length ? r.reduce((s, x) => s + x, 0) / r.length : Number.POSITIVE_INFINITY;
      };
      let picked = col;
      if (ci > 0 && col.length > NET_MAX_ROWS) {
        const groups = new Map<number, typeof col>();
        for (const n of col) {
          const g = Math.min(
            Number.POSITIVE_INFINITY,
            ...(neighbours.get(n.id) ?? []).map((x) => prev.get(x) ?? Number.POSITIVE_INFINITY),
          );
          groups.set(g, [...(groups.get(g) ?? []), n]);
        }
        const queues = [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
        picked = [];
        for (let i = 0; picked.length < NET_MAX_ROWS; i++) {
          const before = picked.length;
          for (const q of queues) {
            const n = q[i];
            if (n && picked.length < NET_MAX_ROWS) picked.push(n);
          }
          if (picked.length === before) break;
        }
      }
      const ordered = ci === 0 ? picked : [...picked].sort((a, b) => rank(a.id) - rank(b.id));
      shown.push(ordered.slice(0, NET_MAX_ROWS));
      hidden.push(Math.max(0, col.length - NET_MAX_ROWS));
    });
    const labelled = edges.some((e) => e.label);
    const gap = labelled ? NET_EDGE_CHARS * 6 + 24 : 72;
    const widths = shown.map((nodes) => Math.max(48, ...nodes.map((n) => nodeWidth(n.label))));
    const colX: number[] = [];
    let cursor = NET_MARGIN;
    widths.forEach((w) => {
      colX.push(cursor + w / 2);
      cursor += w + gap;
    });
    const width = Math.max(320, cursor - gap + NET_MARGIN);
    const shift = (width - (cursor - gap + NET_MARGIN)) / 2;
    const rows = Math.max(1, ...shown.map((c, i) => c.length + ((hidden[i] ?? 0) > 0 ? 1 : 0)));
    const height = Math.max(80, rows * NET_ROW + 16);
    const pos = new Map<string, { x: number; y: number; w: number; col: number }>();
    shown.forEach((nodes, ci) => {
      const total = nodes.length + ((hidden[ci] ?? 0) > 0 ? 1 : 0);
      const top = (height - total * NET_ROW) / 2 + NET_ROW / 2;
      nodes.forEach((n, ri) => {
        pos.set(n.id, {
          x: (colX[ci] ?? 0) + shift,
          y: top + ri * NET_ROW,
          w: nodeWidth(n.label),
          col: ci,
        });
      });
    });
    const more = shown
      .map((nodes, ci) => ({
        ci,
        count: hidden[ci] ?? 0,
        x: (colX[ci] ?? 0) + shift,
        y: (height - (nodes.length + 1) * NET_ROW) / 2 + NET_ROW / 2 + nodes.length * NET_ROW,
      }))
      .filter((m) => m.count > 0);
    const role = new Map(spec.nodes.map((n) => [n.id, n.role]));
    const labelSeen = new Set<string>();
    const drawn = edges.flatMap((e) => {
      const a = pos.get(e.from);
      const b = pos.get(e.to);
      if (!a || !b || a.col === b.col) return [];
      const [l, r] = a.x <= b.x ? [a, b] : [b, a];
      const x1 = l.x + l.w / 2;
      const x2 = r.x - r.w / 2;
      const mx = (x1 + x2) / 2;
      const toRole = role.get(e.to);
      const edgeRole = toRole && toRole !== "center" ? toRole : role.get(e.from);
      const anchorRight = (shown[r.col]?.length ?? 0) >= (shown[l.col]?.length ?? 0);
      const anchorId = (anchorRight ? r : l) === b ? e.to : e.from;
      const key = `${anchorId}|${anchorRight ? "r" : "l"}`;
      const showLabel = !!e.label && !labelSeen.has(key);
      if (showLabel) labelSeen.add(key);
      return [
        {
          e,
          d: `M${x1} ${l.y} C${mx} ${l.y} ${mx} ${r.y} ${x2} ${r.y}`,
          role: edgeRole,
          label: showLabel
            ? anchorRight
              ? { x: x2 - 4, y: r.y - 4, anchor: "end" as const }
              : { x: x1 + 4, y: l.y - 4, anchor: "start" as const }
            : null,
        },
      ];
    });
    return { pos, width, height, more, drawn };
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
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        style={{ maxWidth: layout.width }}
        role="img"
        aria-label={`${spec.title}: ${spec.edges.map((e) => `${e.from} to ${e.to}${e.label ? ` (${e.label})` : ""}`).join("; ")}`}
      >
        {layout.drawn.map(({ e, d, role }, i) => (
          <g key={`${e.from}-${e.to}-${String(i)}`} className="viz-edge" data-role={role}>
            <path d={d} />
            {e.label ? <title>{e.label}</title> : null}
          </g>
        ))}
        {layout.drawn.map(({ e, label }, i) =>
          label && e.label ? (
            <text
              key={`l-${e.from}-${e.to}-${String(i)}`}
              className="viz-edge-label"
              x={label.x}
              y={label.y}
              textAnchor={label.anchor}
            >
              {edgeText(e.label)}
            </text>
          ) : null,
        )}
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
                {nodeText(n.label)}
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

function isEmpty(spec: VizSpec): boolean {
  switch (spec.kind) {
    case "kpis":
      return spec.items.length === 0;
    case "donut":
      return spec.slices.length === 0;
    case "bar":
      return spec.bars.length === 0;
    case "line":
      return !spec.series.some((s) => s.points.some((p) => Number.isFinite(p.y)));
    case "table":
      return spec.rows.length === 0;
    case "timeline":
      return spec.events.length === 0;
    case "network":
      return spec.nodes.length === 0;
    default:
      return true;
  }
}

export function Viz({ spec, onSource }: { spec: VizSpec; onSource?: (id: string) => void }) {
  if (isEmpty(spec)) return null;
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
