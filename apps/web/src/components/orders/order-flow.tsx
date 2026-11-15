"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Pane } from "@/components/ui/pane";
import type { BuyerGroup, CleanOrder } from "@/server/orders/clean";
import type { FlowEdge, OrderFlow } from "@/server/orders/flow";

const GROUP_ORDER: readonly BuyerGroup[] = [
  "Defence",
  "Railways & metro",
  "Power",
  "Coal, mining & metals",
  "Oil & gas",
  "Roads, ports & urban",
  "Other government",
  "Private (India)",
  "Overseas",
  "Unclear",
];

const GROUP_VAR: Record<BuyerGroup, string> = {
  Defence: "var(--of-defence)",
  "Railways & metro": "var(--of-rail)",
  Power: "var(--of-power)",
  "Coal, mining & metals": "var(--of-mining)",
  "Oil & gas": "var(--of-oil)",
  "Roads, ports & urban": "var(--of-urban)",
  "Other government": "var(--of-gov)",
  "Private (India)": "var(--of-private)",
  Overseas: "var(--of-overseas)",
  Unclear: "var(--of-unclear)",
};

const MONTHS = [3, 6, 12, 24] as const;
const W = 1000;
const LEFT_X = 300;
const RIGHT_X = 690;
const BAR = 10;
const GAP = 3;
const MIN_SLOT = 15;
const MAX_BUYERS = 20;
const MAX_SUPPLIERS = 22;
const OTHER_B = "__other_buyers";
const OTHER_S = "__other_suppliers";

const mid = (low: number, high: number | null) => (high == null ? low : (low + high) / 2);

function cr(v: number): string {
  if (v >= 1e5) return `₹${(v / 1e5).toFixed(2)} lakh Cr`;
  return `₹${Math.round(v).toLocaleString("en-IN")} Cr`;
}

function range(low: number, high: number | null): string {
  if (low <= 0 && (high ?? 0) <= 0) return "value not disclosed";
  if (high == null) return `≥ ${cr(low)}`;
  if (Math.abs(high - low) < 0.5) return cr(low);
  if (high < 1e5)
    return `₹${Math.round(low).toLocaleString("en-IN")}–${Math.round(high).toLocaleString("en-IN")} Cr`;
  return `${cr(low)} – ${cr(high)}`;
}

function orderValue(o: CleanOrder): string {
  if (o.value?.basis === "band") return `${range(o.value.low, o.value.high)} (${o.value.band})`;
  if (o.value) return cr(o.value.low);
  if (o.foreignCurrency) return `${o.foreignCurrency} value, not converted`;
  return "not disclosed";
}

const trunc = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

const BOILERPLATE = [
  /^(re|ref|sub|subject)\s*[:.-][^.]*?(?=(dear|pursuant|in terms|we|the company|[A-Z][a-z]+ [A-Z]))/i,
  /dear sir\s*\/?\s*madam,?/gi,
  /(pursuant to|in terms of|in compliance with)( the provisions of)? regulation 30[^,]*?(regulations?,? 2015|lodr\)? regulations?,? 2015|listing regulations)[^,]*,?/gi,
  /read with (para|part|schedule)[^,]*,?/gi,
  /\(as amended\)/gi,
  /we (wish|would like|are pleased|hereby) to inform( you)?( that)?,?/gi,
  /this is to inform( you)?( that)?,?/gi,
  /please find (attached|enclosed)[^.]*\./gi,
];

function excerpt(claim: string): string {
  let s = claim;
  for (const re of BOILERPLATE) s = s.replace(re, " ");
  s = s
    .replace(/\s+/g, " ")
    .replace(/^[\s,.;:-]+/, "")
    .trim();
  return s.length >= 30 ? s : claim;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

type Sel = { kind: "buyer" | "supplier"; key: string } | null;

interface LayoutNode {
  key: string;
  label: string;
  value: string;
  group: BuyerGroup | null;
  y: number;
  h: number;
  w: number;
  members: number;
}

interface LayoutLink {
  buyer: string;
  supplier: string;
  d: string;
  group: BuyerGroup | null;
  title: string;
  hairline: boolean;
}

function solveScale(weights: number[], height: number): number {
  const gaps = GAP * Math.max(0, weights.length - 1);
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  let s = (height - gaps) / total;
  for (let i = 0; i < 6; i++) {
    const fixed = weights.filter((w) => w * s < MIN_SLOT);
    const free = total - fixed.reduce((a, b) => a + b, 0);
    if (free <= 0) break;
    s = Math.max(0, (height - gaps - fixed.length * MIN_SLOT) / free);
  }
  return s;
}

function buildLayout(
  edges: readonly FlowEdge[],
  flow: OrderFlow,
  height: number,
): { left: LayoutNode[]; right: LayoutNode[]; links: LayoutLink[]; height: number } {
  const buyerMeta = new Map(flow.buyers.map((b) => [b.key, b]));
  const supplierMeta = new Map(flow.suppliers.map((s) => [s.symbol, s]));
  const totalMid = edges.reduce((a, e) => a + mid(e.low, e.high), 0) || 1;
  const eps = totalMid * 0.0015;
  const weightOf = (e: FlowEdge) => mid(e.low, e.high) + eps;
  const bw = new Map<string, number>();
  const sw = new Map<string, number>();
  for (const e of edges) {
    bw.set(e.buyer, (bw.get(e.buyer) ?? 0) + weightOf(e));
    sw.set(e.supplier, (sw.get(e.supplier) ?? 0) + weightOf(e));
  }
  const topB = new Set(
    [...bw.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_BUYERS)
      .map(([k]) => k),
  );
  const topS = new Set(
    [...sw.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_SUPPLIERS)
      .map(([k]) => k),
  );
  const agg = new Map<
    string,
    {
      buyer: string;
      supplier: string;
      w: number;
      low: number;
      high: number | null;
      orders: number;
      raw: number;
    }
  >();
  const members = { b: new Set<string>(), s: new Set<string>() };
  for (const e of edges) {
    const b = topB.has(e.buyer) ? e.buyer : OTHER_B;
    const s = topS.has(e.supplier) ? e.supplier : OTHER_S;
    if (b === OTHER_B) members.b.add(e.buyer);
    if (s === OTHER_S) members.s.add(e.supplier);
    const k = `${b}→${s}`;
    const x = agg.get(k) ?? { buyer: b, supplier: s, w: 0, low: 0, high: 0, orders: 0, raw: 0 };
    x.w += weightOf(e);
    x.raw += mid(e.low, e.high);
    x.low += e.low;
    x.high = x.high == null || e.high == null ? null : x.high + e.high;
    x.orders += e.orders;
    agg.set(k, x);
  }
  const links = [...agg.values()];
  const sideNodes = (side: "b" | "s") => {
    const totals = new Map<string, { w: number; low: number; high: number | null }>();
    for (const l of links) {
      const k = side === "b" ? l.buyer : l.supplier;
      const t = totals.get(k) ?? { w: 0, low: 0, high: 0 };
      t.w += l.w;
      t.low += l.low;
      t.high = t.high == null || l.high == null ? null : t.high + l.high;
      totals.set(k, t);
    }
    return [...totals.entries()].map(([key, t]) => {
      const other = key === OTHER_B || key === OTHER_S;
      const group = side === "b" && !other ? (buyerMeta.get(key)?.group ?? null) : null;
      const label = other
        ? `${members[side].size} other ${side === "b" ? "buyers" : "contractors"}`
        : side === "b"
          ? (buyerMeta.get(key)?.name ?? key)
          : key;
      return {
        key,
        label,
        value: range(t.low, t.high),
        group,
        w: t.w,
        y: 0,
        h: 0,
        members: other ? members[side].size : 1,
        other,
      };
    });
  };
  const left = sideNodes("b").sort(
    (a, b) =>
      Number(a.other) - Number(b.other) ||
      GROUP_ORDER.indexOf(a.group ?? "Unclear") - GROUP_ORDER.indexOf(b.group ?? "Unclear") ||
      b.w - a.w,
  );
  const right = sideNodes("s").sort((a, b) => Number(a.other) - Number(b.other) || b.w - a.w);
  const inner = height - 16;
  const scale = Math.min(
    solveScale(
      left.map((n) => n.w),
      inner,
    ),
    solveScale(
      right.map((n) => n.w),
      inner,
    ),
  );
  const place = (nodes: typeof left) => {
    let y = 8;
    for (const n of nodes) {
      n.h = Math.max(1.5, n.w * scale);
      n.y = y;
      y += Math.max(MIN_SLOT, n.h) + GAP;
    }
    return y;
  };
  const usedL = place(left);
  const usedR = place(right);
  const usedH = Math.max(usedL, usedR) + 8;
  const lIndex = new Map(left.map((n) => [n.key, n]));
  const rIndex = new Map(right.map((n) => [n.key, n]));
  const lOffset = new Map<string, number>();
  const rOffset = new Map<string, number>();
  const ordered = [...links].sort(
    (a, b) =>
      (lIndex.get(a.buyer)?.y ?? 0) - (lIndex.get(b.buyer)?.y ?? 0) ||
      (rIndex.get(a.supplier)?.y ?? 0) - (rIndex.get(b.supplier)?.y ?? 0),
  );
  const yL = new Map<string, number>();
  for (const l of ordered) {
    const off = lOffset.get(l.buyer) ?? 0;
    yL.set(`${l.buyer}→${l.supplier}`, off);
    lOffset.set(l.buyer, off + l.w * scale);
  }
  const byRight = [...links].sort(
    (a, b) =>
      (rIndex.get(a.supplier)?.y ?? 0) - (rIndex.get(b.supplier)?.y ?? 0) ||
      (lIndex.get(a.buyer)?.y ?? 0) - (lIndex.get(b.buyer)?.y ?? 0),
  );
  const yR = new Map<string, number>();
  for (const l of byRight) {
    const off = rOffset.get(l.supplier) ?? 0;
    yR.set(`${l.buyer}→${l.supplier}`, off);
    rOffset.set(l.supplier, off + l.w * scale);
  }
  const x0 = LEFT_X + BAR;
  const x1 = RIGHT_X;
  const xm = (x0 + x1) / 2;
  const out: LayoutLink[] = links.map((l) => {
    const k = `${l.buyer}→${l.supplier}`;
    const a = lIndex.get(l.buyer);
    const b = rIndex.get(l.supplier);
    const t = Math.max(0.6, l.w * scale);
    const y0 = (a?.y ?? 0) + (yL.get(k) ?? 0);
    const y1 = (b?.y ?? 0) + (yR.get(k) ?? 0);
    const supplierName =
      l.supplier === OTHER_S
        ? "other contractors"
        : (supplierMeta.get(l.supplier)?.name ?? l.supplier);
    const buyerName =
      l.buyer === OTHER_B ? "other buyers" : (buyerMeta.get(l.buyer)?.name ?? l.buyer);
    return {
      buyer: l.buyer,
      supplier: l.supplier,
      group: l.buyer === OTHER_B ? null : (buyerMeta.get(l.buyer)?.group ?? null),
      hairline: l.raw <= 0,
      title: `${buyerName} → ${supplierName}: ${range(l.low, l.high)} · ${l.orders} order${l.orders === 1 ? "" : "s"}`,
      d: `M${x0} ${y0} C${xm} ${y0} ${xm} ${y1} ${x1} ${y1} L${x1} ${y1 + t} C${xm} ${y1 + t} ${xm} ${y0 + t} ${x0} ${y0 + t} Z`,
    };
  });
  const strip = ({ other: _o, ...n }: (typeof left)[number]): LayoutNode => n;
  return { left: left.map(strip), right: right.map(strip), links: out, height: usedH };
}

function csvCell(v: string | number | null | undefined): string {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function downloadCsv(flow: OrderFlow) {
  const head = [
    "date",
    "contractor",
    "contractor_name",
    "buyer",
    "buyer_group",
    "status",
    "value_low_cr",
    "value_high_cr",
    "value_basis",
    "lt_band",
    "foreign_currency",
    "buyer_as_extracted",
    "notes",
    "filing_url",
  ];
  const rows = flow.orders.map((o) =>
    [
      o.date,
      o.supplier,
      o.supplierName,
      o.buyer,
      o.buyerGroup,
      o.status,
      o.value?.low ?? "",
      o.value ? (o.value.high ?? "open") : "",
      o.value?.basis ?? (o.foreignCurrency ? "foreign" : "undisclosed"),
      o.value?.band ?? "",
      o.foreignCurrency ?? "",
      o.buyerRaw,
      o.flags.join("; "),
      o.url,
    ]
      .map(csvCell)
      .join(","),
  );
  const blob = new Blob([`${head.join(",")}\n${rows.join("\n")}\n`], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `india-order-flow-${flow.months}m-${flow.asOf ?? "latest"}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function OrderList({ orders, side }: { orders: CleanOrder[]; side: "buyer" | "supplier" }) {
  if (!orders.length) return <p className="muted">No orders in this window.</p>;
  return (
    <ol className="of-orders">
      {orders.map((o) => (
        <li key={o.id} data-status={o.status}>
          <div className="of-order-top">
            <time>{o.date}</time>
            <b>{side === "buyer" ? o.supplier : trunc(o.buyer, 34)}</b>
            <span className="of-order-val">{orderValue(o)}</span>
          </div>
          <div className="of-order-meta">
            {o.status !== "awarded" ? (
              <span className="badge" data-tone="warn">
                {o.status === "l1" ? "L1 / not yet awarded" : "cancelled"}
              </span>
            ) : null}
            {o.flags.map((f) => (
              <span key={f} className="badge">
                {f}
              </span>
            ))}
            <a href={o.url} target="_blank" rel="noopener noreferrer">
              filing ↗
            </a>
          </div>
          <p className="of-order-claim">{trunc(excerpt(o.claim), 220)}</p>
        </li>
      ))}
    </ol>
  );
}

export function OrderFlowView({ flow }: { flow: OrderFlow }) {
  const [sel, setSel] = useState<Sel>(null);
  const [hot, setHot] = useState<Sel>(null);
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
  const [hiddenGroups, setHiddenGroups] = useState<ReadonlySet<BuyerGroup>>(new Set());
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") setSel(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const buyerMeta = useMemo(() => new Map(flow.buyers.map((b) => [b.key, b])), [flow]);
  const supplierMeta = useMemo(() => new Map(flow.suppliers.map((s) => [s.symbol, s])), [flow]);
  const edges = useMemo(
    () =>
      flow.edges.filter((e) => {
        const g = buyerMeta.get(e.buyer)?.group;
        return !removed.has(e.buyer) && !(g && hiddenGroups.has(g));
      }),
    [flow, removed, hiddenGroups, buyerMeta],
  );
  const layout = useMemo(() => buildLayout(edges, flow, 590), [edges, flow]);
  const base = flow.totals;
  const baseLow = base.disclosedCr + base.bandLowCr;
  const baseHigh = base.bandHighCr == null ? null : base.disclosedCr + base.bandHighCr;
  const activeLow = edges.reduce((a, e) => a + e.low, 0);
  const activeHigh = edges.some((e) => e.high == null)
    ? null
    : edges.reduce((a, e) => a + (e.high ?? 0), 0);
  const filtered = removed.size > 0 || hiddenGroups.size > 0;
  const baseMid = mid(baseLow, baseHigh) || 1;
  const topBuyer = flow.buyers.find((b) => b.group !== "Unclear");
  const toggleRemove = (key: string) =>
    setRemoved((r) => {
      const n = new Set(r);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
  const toggleGroup = (g: BuyerGroup) =>
    setHiddenGroups((r) => {
      const n = new Set(r);
      if (n.has(g)) n.delete(g);
      else n.add(g);
      return n;
    });
  const raw = hot ?? sel;
  const focus = raw && !(raw.kind === "buyer" && removed.has(raw.key)) ? raw : null;
  const isLit = (b: string, s: string) =>
    !focus || (focus.kind === "buyer" ? b === focus.key : s === focus.key);
  const isNode = (kind: "buyer" | "supplier", key: string) =>
    (sel?.kind === kind && sel.key === key) || (hot?.kind === kind && hot.key === key);
  const pick = (kind: "buyer" | "supplier", key: string) => {
    if (key === OTHER_B || key === OTHER_S) return;
    setSel((cur) => (cur && cur.kind === kind && cur.key === key ? null : { kind, key }));
  };

  return (
    <>
      <Pane
        id="orders-map"
        title="ORDER FLOW · WHO ORDERS FROM WHOM"
        meta={`${flow.from ?? "—"} → ${flow.asOf ?? "—"} · ${base.awardedOrders} awarded orders · NSE filings`}
        hints="click a buyer or contractor · esc clears"
        actions={
          <div className="of-actions">
            {MONTHS.map((m) => (
              <Link
                key={m}
                href={`/orders?m=${m}`}
                className="of-tab"
                data-active={flow.months === m ? "true" : undefined}
                prefetch={false}
              >
                {m}M
              </Link>
            ))}
            <button type="button" className="of-tab" onClick={() => downloadCsv(flow)}>
              CSV
            </button>
          </div>
        }
      >
        <div className="of-wrap">
          <dl className="of-kpis">
            <div>
              <dt>Awarded value</dt>
              <dd>{range(baseLow, baseHigh)}</dd>
              <small>
                {cr(base.disclosedCr)} stated · {range(base.bandLowCr, base.bandHighCr)} from
                L&amp;T size bands
              </small>
            </div>
            <div>
              <dt>Public-sector buyers</dt>
              <dd>{base.publicSharePct == null ? "—" : `${Math.round(base.publicSharePct)}%`}</dd>
              <small>of awarded value (central, state, PSUs)</small>
            </div>
            <div>
              <dt>Largest buyer</dt>
              <dd>{topBuyer ? trunc(topBuyer.name, 22) : "—"}</dd>
              <small>
                {topBuyer
                  ? `${Math.round((mid(topBuyer.low, topBuyer.high) / baseMid) * 100)}% of value · ${topBuyer.suppliers} contractors`
                  : ""}
              </small>
            </div>
            <div>
              <dt>Network</dt>
              <dd>
                {base.buyers} → {base.suppliers}
              </dd>
              <small>identified buyers → listed contractors</small>
            </div>
            <div>
              <dt>Value not stated</dt>
              <dd>{base.undisclosedOrders + base.foreignOrders}</dd>
              <small>orders ({base.foreignOrders} in foreign currency) · drawn as hairlines</small>
            </div>
          </dl>
          {filtered ? (
            <div className="of-whatif" role="status">
              <span>
                Map without{" "}
                {[...removed]
                  .map((k) => buyerMeta.get(k)?.name ?? k)
                  .concat([...hiddenGroups])
                  .join(", ")}
                : <b>{range(activeLow, activeHigh)}</b> (
                {Math.round((1 - mid(activeLow, activeHigh) / baseMid) * 100)}% less disclosed
                value)
              </span>
              <button
                type="button"
                onClick={() => {
                  setRemoved(new Set());
                  setHiddenGroups(new Set());
                }}
              >
                restore all
              </button>
            </div>
          ) : null}
          <ul className="of-legend" aria-label="Buyer groups (click to hide)">
            {flow.groups.map((g) => (
              <li key={g.group}>
                <button
                  type="button"
                  data-off={hiddenGroups.has(g.group) ? "true" : undefined}
                  onClick={() => toggleGroup(g.group)}
                  title={`${g.group}: ${range(g.low, g.high)} · ${g.orders} orders. Click to hide.`}
                >
                  <i style={{ background: GROUP_VAR[g.group] }} />
                  {g.group}
                  <em>{Math.round((mid(g.low, g.high) / baseMid) * 100)}%</em>
                </button>
              </li>
            ))}
          </ul>
          <div className="of-cols" aria-hidden="true">
            <span>BUYERS (who placed the order)</span>
            <span>LISTED CONTRACTORS (who disclosed it)</span>
          </div>
          <div className="of-mapbox">
            <svg className="of-map" viewBox={`0 0 ${W} ${layout.height}`} aria-hidden="true">
              {layout.links.map((l) => (
                <path
                  key={`${l.buyer}→${l.supplier}`}
                  className="of-link"
                  d={l.d}
                  style={{ fill: l.group ? GROUP_VAR[l.group] : "var(--fg-muted)" }}
                  data-lit={isLit(l.buyer, l.supplier) ? "true" : "false"}
                  data-hair={l.hairline ? "true" : undefined}
                >
                  <title>{l.title}</title>
                </path>
              ))}
              {layout.left.map((n) => (
                <g
                  key={n.key}
                  className="of-node"
                  data-active={isNode("buyer", n.key) ? "true" : undefined}
                >
                  <rect
                    x={LEFT_X}
                    y={n.y}
                    width={BAR}
                    height={n.h}
                    style={{ fill: n.group ? GROUP_VAR[n.group] : "var(--fg-muted)" }}
                  />
                  <text x={LEFT_X - 8} y={n.y + Math.min(n.h, MIN_SLOT) / 2 + 4} textAnchor="end">
                    <tspan className="of-val">{n.value} </tspan>
                    {trunc(n.label, 24)}
                  </text>
                </g>
              ))}
              {layout.right.map((n) => (
                <g
                  key={n.key}
                  className="of-node"
                  data-active={isNode("supplier", n.key) ? "true" : undefined}
                >
                  <rect x={RIGHT_X} y={n.y} width={BAR} height={n.h} className="of-supplier-bar" />
                  <text x={RIGHT_X + BAR + 8} y={n.y + Math.min(n.h, MIN_SLOT) / 2 + 4}>
                    {trunc(n.label, 16)}
                    <tspan className="of-val"> {n.value}</tspan>
                  </text>
                </g>
              ))}
            </svg>
            {(["buyer", "supplier"] as const).flatMap((side) =>
              (side === "buyer" ? layout.left : layout.right).map((n) => {
                const other = n.key === OTHER_B || n.key === OTHER_S;
                const x = side === "buyer" ? 0 : RIGHT_X;
                const w = side === "buyer" ? LEFT_X + BAR : W - RIGHT_X;
                return (
                  <button
                    key={`${side}:${n.key}`}
                    type="button"
                    className="of-hit"
                    disabled={other}
                    aria-pressed={sel?.kind === side && sel.key === n.key}
                    aria-label={`${side === "buyer" ? "Buyer" : "Contractor"} ${n.label}: ${n.value}`}
                    title={other ? `${n.label} (grouped to keep the map readable)` : undefined}
                    style={{
                      left: `${(x / W) * 100}%`,
                      width: `${(w / W) * 100}%`,
                      top: `${((n.y - 1) / layout.height) * 100}%`,
                      height: `${((Math.max(MIN_SLOT, n.h) + 2) / layout.height) * 100}%`,
                    }}
                    onClick={() => pick(side, n.key)}
                    onMouseEnter={() => setHot({ kind: side, key: n.key })}
                    onMouseLeave={() => setHot(null)}
                    onFocus={() => setHot({ kind: side, key: n.key })}
                    onBlur={() => setHot(null)}
                  />
                );
              }),
            )}
          </div>
          <p className="of-foot">
            Band width = order value (midpoint where only a range is known). Each order is a
            contract win a listed company disclosed to NSE; buyers are as named in the filing,
            grouped by us.{" "}
            {flow.coverage
              ? `Coverage: read ${flow.coverage.read.toLocaleString("en-IN")} of ${flow.coverage.filings.toLocaleString("en-IN")} order filings, made by ${flow.coverage.companies} of the companies we track; companies outside our universe are not included.`
              : "Covers the companies we track, not all of NSE."}{" "}
            Not a forecast and not investment advice.
          </p>
        </div>
      </Pane>
      <Pane
        id="orders-detail"
        title={
          sel?.kind === "buyer"
            ? `BUYER · ${trunc(buyerMeta.get(sel.key)?.name ?? sel.key, 28)}`
            : sel?.kind === "supplier"
              ? `CONTRACTOR · ${sel.key}`
              : "READING THE MAP"
        }
        meta={
          sel ? (
            <button type="button" className="of-link-btn" onClick={() => setSel(null)}>
              clear
            </button>
          ) : null
        }
        pad
      >
        {sel?.kind === "buyer" ? (
          <BuyerDetail
            flow={flow}
            buyerKey={sel.key}
            removed={removed.has(sel.key)}
            onToggleRemove={() => toggleRemove(sel.key)}
            onPickSupplier={(s) => pick("supplier", s)}
            baseMid={baseMid}
          />
        ) : sel?.kind === "supplier" ? (
          <SupplierDetail
            flow={flow}
            symbol={sel.key}
            onPickBuyer={(b) => pick("buyer", b)}
            supplierName={supplierMeta.get(sel.key)?.name ?? sel.key}
          />
        ) : (
          <Overview
            flow={flow}
            baseMid={baseMid}
            onPickSupplier={(s) => pick("supplier", s)}
            onPickBuyer={(b) => pick("buyer", b)}
          />
        )}
      </Pane>
    </>
  );
}

function BuyerDetail({
  flow,
  buyerKey,
  removed,
  onToggleRemove,
  onPickSupplier,
  baseMid,
}: {
  flow: OrderFlow;
  buyerKey: string;
  removed: boolean;
  onToggleRemove: () => void;
  onPickSupplier: (s: string) => void;
  baseMid: number;
}) {
  const b = flow.buyers.find((x) => x.key === buyerKey);
  const suppliers = new Map(flow.suppliers.map((s) => [s.symbol, s]));
  const exposure = flow.edges
    .filter((e) => e.buyer === buyerKey)
    .map((e) => {
      const s = suppliers.get(e.supplier);
      const fromBuyer = mid(e.low, e.high);
      const total = s ? mid(s.low, s.high) : 0;
      return {
        e,
        s,
        sharePct: total > 0 ? (fromBuyer / total) * 100 : null,
        revenuePct: s?.revenueCr ? (fromBuyer / s.revenueCr) * 100 : null,
      };
    })
    .sort(
      (a, b2) =>
        (b2.sharePct ?? -1) - (a.sharePct ?? -1) ||
        mid(b2.e.low, b2.e.high) - mid(a.e.low, a.e.high),
    );
  const orders = flow.orders.filter((o) => o.buyerKey === buyerKey);
  if (!b) return <p className="muted">No awarded orders for this buyer in the window.</p>;
  const dependent = exposure.filter((x) => (x.sharePct ?? 0) >= 50).length;
  return (
    <div className="of-detail">
      <p className="of-chipline">
        <span className="of-dot" style={{ background: GROUP_VAR[b.group] }} />
        {b.group} · {plural(b.orders, "order")} · {plural(b.suppliers, "contractor")}
      </p>
      <dl className="of-mini">
        <div>
          <dt>Awarded value</dt>
          <dd>{range(b.low, b.high)}</dd>
        </div>
        <div>
          <dt>Share of map</dt>
          <dd>{Math.round((mid(b.low, b.high) / baseMid) * 100)}%</dd>
        </div>
        <div>
          <dt>Value not stated</dt>
          <dd>{plural(b.undisclosed, "order")}</dd>
        </div>
      </dl>
      <h3>If this buyer stopped ordering</h3>
      <p className="muted">
        {dependent > 0
          ? `${dependent} contractor${dependent === 1 ? "" : "s"} took at least half of their disclosed wins in this window from ${b.name}.`
          : `No contractor relied on ${b.name} for half or more of its disclosed wins in this window.`}{" "}
        Share is of disclosed order value only, not of revenue or order book.
      </p>
      <button
        type="button"
        className="of-btn"
        data-on={removed ? "true" : undefined}
        onClick={onToggleRemove}
      >
        {removed ? "Put back on the map" : "Remove from the map"}
      </button>
      <table className="dt of-table">
        <thead>
          <tr>
            <th>Contractor</th>
            <th data-num="true">From buyer</th>
            <th
              data-num="true"
              title="Share of the contractor's disclosed order wins in this window"
            >
              Share of wins
            </th>
            <th
              data-num="true"
              title="Order value from this buyer as a share of latest annual revenue"
            >
              % of revenue
            </th>
          </tr>
        </thead>
        <tbody>
          {exposure.map(({ e, sharePct, revenuePct }) => (
            <tr key={e.supplier}>
              <td>
                <button
                  type="button"
                  className="of-link-btn"
                  onClick={() => onPickSupplier(e.supplier)}
                >
                  {e.supplier}
                </button>
              </td>
              <td data-num="true">{e.low > 0 ? range(e.low, e.high) : "n/s"}</td>
              <td data-num="true">{sharePct == null ? "—" : `${Math.round(sharePct)}%`}</td>
              <td data-num="true">
                {revenuePct == null || e.low <= 0 ? "—" : `${Math.round(revenuePct)}%`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3>Orders</h3>
      <OrderList orders={orders} side="buyer" />
    </div>
  );
}

function SupplierDetail({
  flow,
  symbol,
  supplierName,
  onPickBuyer,
}: {
  flow: OrderFlow;
  symbol: string;
  supplierName: string;
  onPickBuyer: (b: string) => void;
}) {
  const s = flow.suppliers.find((x) => x.symbol === symbol);
  const buyers = new Map(flow.buyers.map((b) => [b.key, b]));
  const rows = flow.edges.filter((e) => e.supplier === symbol);
  const total = rows.reduce((a, e) => a + mid(e.low, e.high), 0) || 1;
  const orders = flow.orders.filter((o) => o.supplier === symbol);
  if (!s) return <p className="muted">No awarded orders for this contractor in the window.</p>;
  return (
    <div className="of-detail">
      <p className="of-chipline">
        {supplierName} ·{" "}
        <Link href={`/c/${encodeURIComponent(symbol)}/des`} prefetch={false}>
          open {symbol} ↗
        </Link>
      </p>
      <dl className="of-mini">
        <div>
          <dt>Awarded value</dt>
          <dd>{range(s.low, s.high)}</dd>
        </div>
        <div>
          <dt>Largest buyer</dt>
          <dd>{s.topBuyerSharePct == null ? "—" : `${Math.round(s.topBuyerSharePct)}%`}</dd>
        </div>
        <div>
          <dt>Wins ÷ revenue</dt>
          <dd>{s.winsToRevenuePct == null ? "—" : `${Math.round(s.winsToRevenuePct)}%`}</dd>
        </div>
      </dl>
      <p className="muted">
        {plural(s.orders, "order")} from {plural(s.buyers, "buyer")}.{" "}
        {s.revenueCr ? `Latest annual revenue ${cr(s.revenueCr)}. ` : ""}
        Multi-year contracts can exceed a year's revenue.
      </p>
      <h3>Who it wins from</h3>
      <ul className="of-bars">
        {rows
          .slice()
          .sort((a, b) => mid(b.low, b.high) - mid(a.low, a.high))
          .map((e) => {
            const b = buyers.get(e.buyer);
            const pct = (mid(e.low, e.high) / total) * 100;
            return (
              <li key={e.buyer}>
                <button
                  type="button"
                  onClick={() => onPickBuyer(e.buyer)}
                  title={`${range(e.low, e.high)} · ${e.orders} orders`}
                >
                  <span className="of-bar-label">{trunc(b?.name ?? e.buyer, 30)}</span>
                  <span className="of-bar-track">
                    <span
                      className="of-bar-fill"
                      style={{
                        width: `${Math.max(1, pct)}%`,
                        background: b ? GROUP_VAR[b.group] : undefined,
                      }}
                    />
                  </span>
                  <span className="of-bar-num">{e.low > 0 ? `${Math.round(pct)}%` : "n/s"}</span>
                </button>
              </li>
            );
          })}
      </ul>
      <h3>Orders</h3>
      <OrderList orders={orders} side="supplier" />
    </div>
  );
}

function Overview({
  flow,
  baseMid,
  onPickSupplier,
  onPickBuyer,
}: {
  flow: OrderFlow;
  baseMid: number;
  onPickSupplier: (s: string) => void;
  onPickBuyer: (b: string) => void;
}) {
  const concentrated = flow.suppliers
    .filter((s) => (s.topBuyerSharePct ?? 0) >= 60 && mid(s.low, s.high) >= 500 && s.orders >= 2)
    .slice(0, 8);
  const topBuyers = flow.buyers.filter((b) => b.group !== "Unclear").slice(0, 6);
  return (
    <div className="of-detail">
      <p>
        Every band is a contract a listed company told NSE it had won, linked to that filing. Left
        is who placed the order, right is who won it. Click either side to see the orders, and
        remove a buyer to see who would be exposed if it stopped ordering.
      </p>
      <h3>Biggest buyers</h3>
      <ul className="of-bars">
        {topBuyers.map((b) => (
          <li key={b.key}>
            <button type="button" onClick={() => onPickBuyer(b.key)}>
              <span className="of-bar-label">{trunc(b.name, 30)}</span>
              <span className="of-bar-track">
                <span
                  className="of-bar-fill"
                  style={{
                    width: `${Math.max(1, (mid(b.low, b.high) / baseMid) * 100)}%`,
                    background: GROUP_VAR[b.group],
                  }}
                />
              </span>
              <span className="of-bar-num">
                {Math.round((mid(b.low, b.high) / baseMid) * 100)}%
              </span>
            </button>
          </li>
        ))}
      </ul>
      <h3>One buyer, most of the wins</h3>
      {concentrated.length ? (
        <ul className="of-conc">
          {concentrated.map((s) => (
            <li key={s.symbol}>
              <button type="button" onClick={() => onPickSupplier(s.symbol)}>
                <b>{s.symbol}</b> {Math.round(s.topBuyerSharePct ?? 0)}% from{" "}
                {trunc(s.topBuyer ?? "", 26)}
                <em>{range(s.low, s.high)}</em>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">No contractor with two or more orders got 60%+ from one buyer.</p>
      )}
      <h3>How the numbers are built</h3>
      <ul className="of-notes">
        <li>
          Source: order-win announcements filed with NSE, read by our extractor. One filing counts
          once even when it was read from both the PDF and NSE&apos;s metadata.
        </li>
        <li>
          L&amp;T discloses size bands, not values (Significant ₹1,000–2,500 Cr up to Ultra-mega
          above ₹15,000 Cr, per its filings); those orders are counted as ranges.
        </li>
        <li>
          Lowest-bidder (L1) positions ({flow.totals.l1Orders}) and cancelled orders (
          {flow.totals.cancelledOrders}) are listed but not counted. Foreign-currency values are not
          converted or added.
        </li>
        <li>
          Set aside:{" "}
          {flow.totals.excluded.map((x, i) => (
            <span key={x.reason}>
              {i ? "; " : ""}
              {x.count} {x.reason}
            </span>
          ))}
          . The CSV lists every counted order with its filing link.
        </li>
        <li>
          Buyer names come from the filing; we merge spellings and group them. Values are as
          disclosed and may include taxes or multi-year scope.
        </li>
      </ul>
    </div>
  );
}
