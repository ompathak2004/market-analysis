export const TABS = ["des", "gp", "fa", "anr", "splc", "news"] as const;
export type Tab = (typeof TABS)[number];

export const TAB_TITLE: Record<Tab, string> = {
  des: "Description",
  gp: "Price chart",
  fa: "Financials",
  anr: "Analyst recs",
  splc: "Supply chain",
  news: "Announcements",
};

export function isTab(v: string): v is Tab {
  return (TABS as readonly string[]).includes(v);
}

export function resolveCommand(raw: string, currentSymbol: string | null): string | null {
  const parts = raw.trim().toUpperCase().split(/\s+/).filter(Boolean);
  const [first, second] = parts;
  if (!first) return null;
  if (first === "HOME") return "/";
  if (first === "MOV" || first === "MOVERS") return "/#movers";
  if (first === "SIG" || first === "SIGNALS")
    return `/signals${second ? `?kind=${second.toLowerCase()}` : ""}`;
  const lower = first.toLowerCase();
  if (isTab(lower)) {
    const sym = second ?? currentSymbol;
    return sym ? `/c/${sym}/${lower}` : null;
  }
  if (second && isTab(second.toLowerCase())) return `/c/${first}/${second.toLowerCase()}`;
  return `/c/${first}/des`;
}
