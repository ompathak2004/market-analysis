import type { ChipTone } from "@/components/ui/chip";

export const VALUE_BASIS_LABEL: Record<string, string> = {
  revenue_share: "REV SHARE",
  purchase_share: "BUY SHARE",
  annual_flow: "FLOW",
  contract_total: "CONTRACT",
  unknown: "UNSTATED",
};

export const VALUE_BASIS_TONE: Record<string, ChipTone> = {
  revenue_share: "pos",
  purchase_share: "info",
  annual_flow: "accent",
  contract_total: "warn",
  unknown: "neu",
};

export const COST_BUCKET_LABEL: Record<string, string> = {
  COGS: "COGS",
  CAPEX: "CAPEX",
  SGA: "SG&A",
  RND: "R&D",
  UNKNOWN: "—",
};

export const FAMILY_LABEL: Record<string, string> = {
  annual_report: "ANNUAL",
  concall: "CONCALL",
  order_filing: "ORDERS",
  announcement_metadata: "ANNOUNCEMENTS",
  rating_rationale: "RATINGS",
  presentation: "DECKS",
  screener: "SCREENER",
  manual: "MANUAL",
};

export const SOURCE_LABEL: Record<string, string> = {
  annual_report: "AR",
  concall: "CONCALL",
  order_filing: "ORDER",
  announcement_metadata: "ANN",
  rating_rationale: "RATING",
  presentation: "DECK",
  screener: "SCREENER",
};

export function basisLabel(basis: string): string {
  return VALUE_BASIS_LABEL[basis] ?? basis.toUpperCase();
}

export function familyLabel(family: string): string {
  return FAMILY_LABEL[family] ?? family.replaceAll("_", " ").toUpperCase();
}

export function sourceLabel(source: string): string {
  return SOURCE_LABEL[source] ?? source.replaceAll("_", " ").toUpperCase();
}

export function confidenceLabel(c: number | null | undefined): string {
  return c == null || !Number.isFinite(c) ? "—" : `${Math.round(c * 100)}%`;
}

export function periodLabel(p: {
  start: string | null;
  end: string | null;
  fiscalYear: number | null;
}): string {
  if (p.fiscalYear) return `FY${String(p.fiscalYear).slice(-2)}`;
  const y = (d: string | null) => (d ? d.slice(0, 7) : null);
  const s = y(p.start);
  const e = y(p.end);
  if (s && e) return s === e ? s : `${s}→${e}`;
  return e ?? s ?? "—";
}
