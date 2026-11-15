import {
  BUYER_GROUPS,
  type BuyerGroup,
  type CleanOrder,
  type ExcludedOrder,
  ORDER_FLOW_VERSION,
  PUBLIC_GROUPS,
} from "./clean";

export interface ValueRange {
  low: number;
  high: number | null;
}

export interface FlowBuyer extends ValueRange {
  key: string;
  name: string;
  group: BuyerGroup;
  orders: number;
  undisclosed: number;
  suppliers: number;
}

export interface FlowSupplier extends ValueRange {
  symbol: string;
  name: string;
  orders: number;
  undisclosed: number;
  buyers: number;
  revenueCr: number | null;
  topBuyer: string | null;
  topBuyerSharePct: number | null;
  winsToRevenuePct: number | null;
}

export interface FlowEdge extends ValueRange {
  buyer: string;
  supplier: string;
  orders: number;
}

export interface OrderFlow {
  version: number;
  months: number;
  asOf: string | null;
  from: string | null;
  totals: {
    awardedOrders: number;
    disclosedCr: number;
    bandLowCr: number;
    bandHighCr: number | null;
    undisclosedOrders: number;
    foreignOrders: number;
    l1Orders: number;
    l1Cr: number;
    cancelledOrders: number;
    suppliers: number;
    buyers: number;
    publicSharePct: number | null;
    excluded: Array<{ reason: string; count: number }>;
  };
  groups: Array<ValueRange & { group: BuyerGroup; orders: number }>;
  buyers: FlowBuyer[];
  suppliers: FlowSupplier[];
  edges: FlowEdge[];
  orders: CleanOrder[];
  excluded: ExcludedOrder[];
  coverage: { filings: number; read: number; companies: number } | null;
}

export const mid = (r: ValueRange) => (r.high == null ? r.low : (r.low + r.high) / 2);

const round = (v: number) => Math.round(v * 100) / 100;

function add(target: ValueRange, o: CleanOrder) {
  if (!o.value) return;
  target.low += o.value.low;
  target.high = target.high == null || o.value.high == null ? null : target.high + o.value.high;
}

export function buildFlow(
  orders: readonly CleanOrder[],
  excluded: readonly ExcludedOrder[],
  revenueCr: ReadonlyMap<string, number>,
  months: number,
): OrderFlow {
  const awarded = orders.filter((o) => o.status === "awarded");
  const buyers = new Map<string, FlowBuyer & { supplierSet: Set<string> }>();
  const suppliers = new Map<
    string,
    FlowSupplier & { buyerTotals: Map<string, number>; buyerSet: Set<string> }
  >();
  const edges = new Map<string, FlowEdge>();
  const groups = new Map<BuyerGroup, ValueRange & { group: BuyerGroup; orders: number }>();
  let disclosedCr = 0;
  let bandLowCr = 0;
  let bandHighCr: number | null = 0;
  let undisclosed = 0;
  let foreign = 0;
  for (const o of awarded) {
    if (o.value?.basis === "disclosed") disclosedCr += o.value.low;
    else if (o.value) {
      bandLowCr += o.value.low;
      bandHighCr = bandHighCr == null || o.value.high == null ? null : bandHighCr + o.value.high;
    } else if (o.foreignCurrency) foreign++;
    else undisclosed++;
    const b =
      buyers.get(o.buyerKey) ??
      ({
        key: o.buyerKey,
        name: o.buyer,
        group: o.buyerGroup,
        low: 0,
        high: 0,
        orders: 0,
        undisclosed: 0,
        suppliers: 0,
        supplierSet: new Set<string>(),
      } satisfies FlowBuyer & { supplierSet: Set<string> });
    b.orders++;
    if (!o.value) b.undisclosed++;
    b.supplierSet.add(o.supplier);
    add(b, o);
    buyers.set(o.buyerKey, b);
    const s =
      suppliers.get(o.supplier) ??
      ({
        symbol: o.supplier,
        name: o.supplierName,
        low: 0,
        high: 0,
        orders: 0,
        undisclosed: 0,
        buyers: 0,
        revenueCr: revenueCr.get(o.supplier) ?? null,
        topBuyer: null,
        topBuyerSharePct: null,
        winsToRevenuePct: null,
        buyerTotals: new Map<string, number>(),
        buyerSet: new Set<string>(),
      } satisfies FlowSupplier & { buyerTotals: Map<string, number>; buyerSet: Set<string> });
    s.orders++;
    if (!o.value) s.undisclosed++;
    s.buyerSet.add(o.buyerKey);
    add(s, o);
    if (o.value) s.buyerTotals.set(o.buyerKey, (s.buyerTotals.get(o.buyerKey) ?? 0) + mid(o.value));
    suppliers.set(o.supplier, s);
    const ek = `${o.buyerKey}→${o.supplier}`;
    const e = edges.get(ek) ?? {
      buyer: o.buyerKey,
      supplier: o.supplier,
      low: 0,
      high: 0,
      orders: 0,
    };
    e.orders++;
    add(e, o);
    edges.set(ek, e);
    const g = groups.get(o.buyerGroup) ?? { group: o.buyerGroup, low: 0, high: 0, orders: 0 };
    g.orders++;
    add(g, o);
    groups.set(o.buyerGroup, g);
  }
  const supplierList: FlowSupplier[] = [...suppliers.values()].map(
    ({ buyerTotals, buyerSet, ...s }) => {
      const total = [...buyerTotals.values()].reduce((a, b) => a + b, 0);
      const top = [...buyerTotals.entries()].sort((a, b) => b[1] - a[1])[0];
      return {
        ...s,
        low: round(s.low),
        high: s.high == null ? null : round(s.high),
        buyers: buyerSet.size,
        topBuyer: top ? (buyers.get(top[0])?.name ?? top[0]) : null,
        topBuyerSharePct: top && total > 0 ? round((top[1] / total) * 100) : null,
        winsToRevenuePct:
          s.revenueCr && s.revenueCr > 0 && total > 0 ? round((total / s.revenueCr) * 100) : null,
      };
    },
  );
  const buyerList: FlowBuyer[] = [...buyers.values()].map(({ supplierSet, ...b }) => ({
    ...b,
    low: round(b.low),
    high: b.high == null ? null : round(b.high),
    suppliers: supplierSet.size,
  }));
  const totalMid = buyerList.reduce((a, b) => a + mid(b), 0);
  const publicMid = buyerList
    .filter((b) => PUBLIC_GROUPS.has(b.group))
    .reduce((a, b) => a + mid(b), 0);
  const l1 = orders.filter((o) => o.status === "l1");
  const reasons = new Map<string, number>();
  for (const x of excluded) reasons.set(x.reason, (reasons.get(x.reason) ?? 0) + 1);
  const dates = orders.map((o) => o.date).sort();
  return {
    version: ORDER_FLOW_VERSION,
    months,
    asOf: dates.at(-1) ?? null,
    from: dates[0] ?? null,
    totals: {
      awardedOrders: awarded.length,
      disclosedCr: round(disclosedCr),
      bandLowCr: round(bandLowCr),
      bandHighCr: bandHighCr == null ? null : round(bandHighCr),
      undisclosedOrders: undisclosed,
      foreignOrders: foreign,
      l1Orders: l1.length,
      l1Cr: round(l1.reduce((a, o) => a + (o.value ? mid(o.value) : 0), 0)),
      cancelledOrders: orders.filter((o) => o.status === "cancelled").length,
      suppliers: supplierList.length,
      buyers: buyerList.filter((b) => b.group !== "Unclear").length,
      publicSharePct: totalMid > 0 ? round((publicMid / totalMid) * 100) : null,
      excluded: [...reasons.entries()].map(([reason, count]) => ({ reason, count })),
    },
    groups: BUYER_GROUPS.flatMap((g) => {
      const x = groups.get(g);
      return x ? [{ ...x, low: round(x.low), high: x.high == null ? null : round(x.high) }] : [];
    }),
    buyers: buyerList.sort((a, b) => mid(b) - mid(a) || b.orders - a.orders),
    suppliers: supplierList.sort((a, b) => mid(b) - mid(a) || b.orders - a.orders),
    edges: [...edges.values()]
      .map((e) => ({ ...e, low: round(e.low), high: e.high == null ? null : round(e.high) }))
      .sort((a, b) => mid(b) - mid(a)),
    orders: [...orders].sort((a, b) => b.date.localeCompare(a.date)),
    excluded: [...excluded].sort((a, b) => b.date.localeCompare(a.date)),
    coverage: null,
  };
}
