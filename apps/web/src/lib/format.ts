const inr = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 });
const inr0 = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });

export function num(v: number | string | null | undefined, digits = 2): string {
  if (v == null || v === "") return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return digits === 0 ? inr0.format(n) : inr.format(Number(n.toFixed(digits)));
}

export function crore(v: number | string | null | undefined): string {
  if (v == null) return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 100_000) return `${num(n / 100_000, 2)} L Cr`;
  return `${num(n, 0)} Cr`;
}

export function pct(v: number | null | undefined, digits = 2, signed = true): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const s = `${v.toFixed(digits)}%`;
  return signed && v > 0 ? `+${s}` : s;
}

export function signed(v: number | null | undefined, digits = 2): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${v > 0 ? "+" : v < 0 ? "-" : ""}${num(Math.abs(v), digits)}`;
}

export function tone(v: number | null | undefined): "up" | "down" | "flat" {
  if (v == null || v === 0 || !Number.isFinite(v)) return "flat";
  return v > 0 ? "up" : "down";
}

export function shortDate(iso: string | Date | null | undefined): string {
  if (!iso) return "—";
  const d = typeof iso === "string" ? new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso) : iso;
  return d
    .toLocaleDateString("en-GB", {
      day: "2-digit",
      month: "short",
      year: "2-digit",
      timeZone: "Asia/Kolkata",
    })
    .replaceAll(" ", "-")
    .toUpperCase();
}

const FISCAL_QUARTER: Record<string, number> = { "06": 1, "09": 2, "12": 3, "03": 4 };

export function fyLabel(periodEnd: string, quarterly = false): string {
  const [y = "", m = ""] = periodEnd.split("-");
  const fy = m === "03" ? Number(y) : Number(y) + 1;
  const q = FISCAL_QUARTER[m];
  if (quarterly && q) return `Q${q} FY${String(fy).slice(2)}`;
  if (!quarterly && m === "03") return `FY${y.slice(2)}`;
  return `${MONTHS[Number(m) - 1] ?? ""}'${y.slice(2)}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function ratingBucket(rating: string): "SB" | "B" | "H" | "S" | "—" {
  const r = rating.toLowerCase();
  if (/strong buy/.test(r)) return "SB";
  if (/buy|outperform|accumulate|add|overweight/.test(r)) return "B";
  if (/hold|neutral|equal|market perform/.test(r)) return "H";
  if (/sell|reduce|underperform|underweight/.test(r)) return "S";
  return "—";
}

export const ACTION_LABEL: Record<string, string> = {
  initiate: "INIT",
  maintain: "MAINT",
  upgrade: "UPGRADE",
  downgrade: "DNGRADE",
  raise_target: "RAISE PT",
  lower_target: "LOWER PT",
  reiterate: "REIT",
  unknown: "—",
};

export const SIGNAL_LABEL: Record<string, string> = {
  customer_concentration_pct: "REV FROM >10% CUSTOMERS",
  customer_momentum_1m: "CUST MOM 1M",
  customer_momentum_2m: "CUST MOM 2M",
  customer_momentum_3m: "CUST MOM 3M",
  supplier_momentum_1m: "SUPP MOM 1M",
  supplier_momentum_2m: "SUPP MOM 2M",
  supplier_momentum_3m: "SUPP MOM 3M",
  customer_hhi: "CUSTOMER HHI",
  distress_score: "DISTRESS SCORE",
};

export function signalLabel(kind: string): string {
  const top = /^top(\d+)_customers_pct$/.exec(kind);
  if (top) return `TOP ${top[1]} CUSTOMERS % REV`;
  return SIGNAL_LABEL[kind] ?? kind.toUpperCase();
}

export function signalValue(kind: string, value: number): string {
  if (kind === "customer_hhi" || kind === "distress_score") return value.toFixed(3);
  return pct(value, 1, /momentum/.test(kind));
}

interface Contributor {
  name?: string;
  weight?: number;
  momentum?: number;
  share?: number;
}

export function inputsSummary(kind: string, inputs: Record<string, unknown>): string {
  const list = (inputs.contributors ?? inputs.customers) as Contributor[] | undefined;
  if (Array.isArray(list)) {
    const from = typeof inputs.from === "string" ? `from ${shortDate(inputs.from)} · ` : "";
    return (
      from +
      list
        .slice(0, 6)
        .map((c) => {
          const parts = [c.name ?? "?"];
          if (c.share != null) parts.push(`share ${(c.share * 100).toFixed(0)}%`);
          if (c.momentum != null) parts.push(pct(c.momentum * 100, 1));
          if (c.weight != null && c.weight !== 1) parts.push(`w ${num(c.weight, 0)}`);
          return parts.join(" ");
        })
        .join(" · ")
    );
  }
  if (kind === "distress_score") {
    const keys = [
      "roe",
      "operatingMargin",
      "debtToEquity",
      "interestCoverage",
      "assetTurnover",
      "leverage",
    ];
    return keys
      .filter((k) => typeof inputs[k] === "number")
      .map((k) => `${k} ${num(inputs[k] as number, 2)}`)
      .join(" · ");
  }
  return Object.entries(inputs)
    .filter(([, v]) => typeof v !== "object")
    .map(([k, v]) => `${k} ${typeof v === "number" ? num(v, 2) : String(v)}`)
    .join(" · ");
}
