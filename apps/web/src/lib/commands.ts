export const TABS = [
  "des",
  "gp",
  "fa",
  "anr",
  "splc",
  "news",
  "jet",
  "ship",
  "intl",
  "infl",
] as const;
export type Tab = (typeof TABS)[number];

export const TAB_TITLE: Record<Tab, string> = {
  des: "Company description",
  gp: "Price chart",
  fa: "Financial analysis",
  anr: "Analyst research",
  splc: "Supply chain",
  news: "Filings & news",
  jet: "Management travel",
  ship: "Logistics & ports",
  intl: "Intelligence brief",
  infl: "Influence",
};

export function isTab(v: string): v is Tab {
  return (TABS as readonly string[]).includes(v);
}

export interface FunctionDef {
  code: string;
  label: string;
  scope: "company" | "global";
  aliases: readonly string[];
}

export const FUNCTIONS: readonly FunctionDef[] = [
  ...TABS.map((t) => ({
    code: t.toUpperCase(),
    label: TAB_TITLE[t],
    scope: "company" as const,
    aliases: [] as string[],
  })),
  { code: "HOME", label: "Market overview", scope: "global", aliases: ["H", "MAIN"] },
  { code: "MOV", label: "NIFTY 50 movers", scope: "global", aliases: ["MOVERS", "TOP"] },
  { code: "SIG", label: "Signal leaderboards", scope: "global", aliases: ["SIGNALS"] },
  { code: "HELP", label: "Keys & functions", scope: "global", aliases: ["?", "KEYS"] },
];

const FN_BY_CODE = new Map<string, FunctionDef>();
for (const f of FUNCTIONS) {
  FN_BY_CODE.set(f.code, f);
  for (const a of f.aliases) FN_BY_CODE.set(a, f);
}

export function functionFor(code: string): FunctionDef | null {
  return FN_BY_CODE.get(code.toUpperCase()) ?? null;
}

export function fuzzyScore(query: string, target: string): number {
  const q = query.toUpperCase();
  const t = target.toUpperCase();
  if (!q) return 0;
  if (t === q) return 100;
  if (t.startsWith(q)) return 80 - Math.min(20, t.length - q.length);
  const idx = t.indexOf(q);
  if (idx >= 0) return 50 - Math.min(20, idx);
  let ti = 0;
  let score = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return -1;
    score += found === ti ? 3 : 1;
    ti = found + 1;
  }
  return Math.min(40, score);
}

export function resolveCommand(raw: string, currentSymbol: string | null): string | null {
  const parts = raw.trim().toUpperCase().split(/\s+/).filter(Boolean);
  const [first, second] = parts;
  if (!first) return null;
  const fn = functionFor(first);
  if (fn?.code === "HOME") return "/";
  if (fn?.code === "MOV") return "/movers";
  if (fn?.code === "HELP") return "/help";
  if (fn?.code === "SIG") return `/signals${second ? `?kind=${second.toLowerCase()}` : ""}`;
  const lower = first.toLowerCase();
  if (isTab(lower)) {
    const sym = second ?? currentSymbol;
    return sym ? `/c/${encodeURIComponent(sym)}/${lower}` : null;
  }
  if (second && isTab(second.toLowerCase()))
    return `/c/${encodeURIComponent(first)}/${second.toLowerCase()}`;
  return `/c/${encodeURIComponent(first)}/des`;
}
