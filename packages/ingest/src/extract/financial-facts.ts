import { isoDate, parseIndianNumber } from "@ma/core";

export const FINANCIAL_FACTS_PARSER_VERSION = 1;

export type FinancialStatement = "consolidated" | "standalone";
export type FinancialUnit = "crore" | "lakh" | "million" | "billion" | "thousand";
export type FinancialFactMetric = "revenue" | "purchases" | "cogs" | "capex" | "rnd";

export interface FinancialFact {
  metric: FinancialFactMetric;
  valueCr: number;
}

export interface FinancialFactsResult {
  statement: FinancialStatement;
  unit: FinancialUnit;
  facts: FinancialFact[];
}

interface RowLayout {
  noteColumn: boolean;
  columns: number;
}

interface Statement {
  kind: FinancialStatement;
  unit: FinancialUnit;
  section: string;
  layout: RowLayout;
  revenue: number;
  end: number;
  before: boolean;
}

interface Label {
  pattern: RegExp;
  tailWords: number;
}

const PNL_HEADING =
  /\b(?:(consolidated|standalone)\s+)?statement\s+of\s+(?:(consolidated|standalone)\s+)?profit\s*(?:and|&)\s*loss\b/gi;
const CASH_FLOW_HEADING =
  /\b(?:(consolidated|standalone)\s+)?(?:statement\s+of\s+(?:(consolidated|standalone)\s+)?cash\s+flows?|cash\s+flow\s+statement)\b/gi;
const NEXT_STATEMENT =
  /statement\s+of\s+(?:changes\s+in\s+equity|cash\s+flows?)|cash\s+flow\s+statement|balance\s+sheet\s+as\s+at/i;
const OTHER_HEADING = /statement\s+of|balance\s+sheet/i;
const YEAR_ENDED = /\bfor\s+the\s+(?:financial\s+)?year\s+ended\b/i;
const YEAR_ENDED_OR_AS_AT = /\bfor\s+the\s+(?:financial\s+)?year\s+ended\b|\bas\s+(?:at|on)\b/i;
const GROUP_LINES =
  /non[\s-]*controlling\s+interests?|owners\s+of\s+the\s+(?:parent|holding\s+company)/i;
const UNIT =
  /(?:₹|`|\brs\b\.?|\binr\b|\brupees\b)\s*(?:in\s+)?(crores?|cr\b|lakhs?|lacs?|millions?|mn\b|billions?|bn\b|thousands?)/gi;
const NOTE_REF =
  /\(\s*(?:refer\s+)?notes?\s*(?:no\.?\s*)?\d[\d.]*\s*[a-z]?(?:\s*(?:,|&|and|to)\s*\d[\d.]*\s*[a-z]?)*\s*\)/gi;
const NUMBER = /^\(?-?\d[\d,]*(?:\.\d+)?\)?$/;
const NOTE = /^\d{1,2}(?:\.\d{1,2})?(?:\([a-z0-9]{1,3}\)|[a-z])?$/i;
const NIL = /^(?:[-–—]{1,2}|nil)$/i;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

const HEADING_TAIL = 250;
const PNL_WINDOW = 8_000;
const REVENUE_REACH = 1_200;
const CASH_FLOW_REACH = 60_000;
const CASH_FLOW_WINDOW = 15_000;
const UNIT_BEFORE = 400;
const UNIT_AFTER = 2_000;
const MAX_COST_TO_REVENUE = 2;

const REVENUE: Label = {
  pattern: /\brevenue\s+from\s+operations\b/gi,
  tailWords: 1,
};
const MATERIALS: Label = {
  pattern: /\bcost\s+of\s+(?:raw\s+)?materials?\s+(?:and\s+components\s+)?consumed\b/gi,
  tailWords: 1,
};
const TRADED: Label = {
  pattern: /\bpurchases?\s+of\s+(?:stock[\s-]*in[\s-]*trade|traded\s+goods|goods\s+traded)\b/gi,
  tailWords: 1,
};
const INVENTORY_CHANGE: Label = {
  pattern:
    /(?:\bchanges?\s+in\s+inventor(?:y|ies)|\(\s*increase\s*\)\s*\/\s*decrease\s+in\s+inventor(?:y|ies))\b/gi,
  tailWords: 14,
};
const RND: Label = {
  pattern: /\bresearch\s+(?:and|&)\s+development\s+(?:expenses?|expenditure|costs?)\b/gi,
  tailWords: 1,
};
const CAPEX: Label = {
  pattern:
    /\b(?:purchases?|acquisitions?|payments?\s+for\s+(?:the\s+)?(?:purchase|acquisition))\s+of\s+(?:property\s*,?\s*plant\s*(?:and|&)\s*equipment|fixed\s+assets)\b/gi,
  tailWords: 32,
};

const UNIT_TO_CRORE: Record<FinancialUnit, number> = {
  crore: 1,
  lakh: 0.01,
  million: 0.1,
  billion: 100,
  thousand: 0.0001,
};

export function extractFinancialFacts(
  text: string,
  periodEnd: string,
): FinancialFactsResult | null {
  const statements = statementsOf(text, periodEnd);
  const chosen =
    statements.find((s) => s.kind === "consolidated") ??
    statements.find((s) => s.kind === "standalone");
  if (!chosen) return null;
  const toCrore = (v: number) => round2(v * UNIT_TO_CRORE[chosen.unit]);
  const facts: FinancialFact[] = [];
  const push = (metric: FinancialFactMetric, valueCr: number) => facts.push({ metric, valueCr });

  const revenue = toCrore(chosen.revenue);
  push("revenue", revenue);

  const materials = rowValue(chosen.section, MATERIALS, chosen.layout);
  const traded = rowValue(chosen.section, TRADED, chosen.layout);
  if (materials !== null || traded !== null) {
    const bought = (materials ?? 0) + (traded ?? 0);
    const purchases = toCrore(bought);
    if (purchases > 0 && purchases <= revenue * MAX_COST_TO_REVENUE) {
      push("purchases", purchases);
      const change = rowValue(chosen.section, INVENTORY_CHANGE, chosen.layout);
      if (change !== null) {
        const cogs = toCrore(bought + change);
        if (cogs > 0 && cogs <= revenue * MAX_COST_TO_REVENUE) push("cogs", cogs);
      }
    }
  }

  const rnd = rowValue(chosen.section, RND, chosen.layout);
  if (rnd !== null && rnd > 0) push("rnd", toCrore(rnd));

  const capex = capexOf(text, chosen, periodEnd);
  if (capex !== null) push("capex", capex);

  return { statement: chosen.kind, unit: chosen.unit, facts };
}

function statementsOf(text: string, periodEnd: string): Statement[] {
  const out: Statement[] = [];
  for (const m of text.matchAll(PNL_HEADING)) {
    const start = m.index;
    const headingEnd = start + m[0].length;
    if (statedYearEnd(headingTail(text, headingEnd), YEAR_ENDED) !== periodEnd) continue;
    const unit = unitNear(text, start);
    if (!unit) continue;
    const raw = text.slice(headingEnd, headingEnd + PNL_WINDOW);
    const next = NEXT_STATEMENT.exec(raw.slice(200));
    const bounded = next ? raw.slice(0, 200 + next.index) : raw;
    const layouts = [
      { before: false, section: normalize(bounded), end: headingEnd + bounded.length },
      { before: true, section: normalize(pageBefore(text, start, PNL_WINDOW)), end: headingEnd },
    ];
    for (const { before, section, end } of layouts) {
      const revenueRow = firstRow(section.slice(0, REVENUE_REACH), REVENUE);
      if (!revenueRow) continue;
      const layout = {
        noteColumn: revenueRow.length >= 3 && NOTE.test(revenueRow[0] as string),
        columns: revenueRow.length,
      };
      const revenue = currentValue(revenueRow, layout);
      if (revenue === null || revenue <= 0) continue;
      const prefix = (m[1] ?? m[2])?.toLowerCase();
      const kind: FinancialStatement =
        prefix === "consolidated" || (prefix !== "standalone" && GROUP_LINES.test(section))
          ? "consolidated"
          : "standalone";
      out.push({ kind, unit, section, layout, revenue, end, before });
      break;
    }
  }
  return out;
}

function capexOf(text: string, statement: Statement, periodEnd: string): number | null {
  const reach = text.slice(statement.end, statement.end + CASH_FLOW_REACH);
  for (const m of reach.matchAll(CASH_FLOW_HEADING)) {
    const prefix = (m[1] ?? m[2])?.toLowerCase();
    if (prefix && prefix !== statement.kind) continue;
    const start = statement.end + m.index;
    const headingEnd = start + m[0].length;
    if (statedYearEnd(headingTail(text, headingEnd), YEAR_ENDED_OR_AS_AT) !== periodEnd) continue;
    const unit = unitNear(text, start) ?? statement.unit;
    const section = normalize(
      statement.before
        ? pageBefore(text, start, CASH_FLOW_WINDOW)
        : text.slice(headingEnd, headingEnd + CASH_FLOW_WINDOW),
    );
    const row = firstRow(section, CAPEX);
    if (!row) return null;
    const value = currentValue(row, { noteColumn: row.length >= 3, columns: row.length });
    if (value === null || value === 0) return null;
    return round2(Math.abs(value) * UNIT_TO_CRORE[unit]);
  }
  return null;
}

function headingTail(text: string, headingEnd: number): string {
  const tail = text.slice(headingEnd, headingEnd + HEADING_TAIL);
  const next = OTHER_HEADING.exec(tail);
  return next ? tail.slice(0, next.index) : tail;
}

function pageBefore(text: string, at: number, window: number): string {
  return text.slice(Math.max(text.lastIndexOf("\n\n", at), at - window, 0), at);
}

function statedYearEnd(tail: string, marker: RegExp): string | null {
  const at = marker.exec(tail);
  if (!at) return null;
  const after = tail.slice(at.index + at[0].length, at.index + at[0].length + 40);
  const dayFirst =
    /^\s*(?:on\s+)?(\d{1,2})(?:st|nd|rd|th)?[\s-]*(?:of\s+)?([a-z]{3,9})\.?,?[\s-]*(20\d{2})/i.exec(
      after,
    );
  if (dayFirst) return monthEnd(Number(dayFirst[3]), monthOf(dayFirst[2] as string));
  const monthFirst =
    /^\s*(?:on\s+)?([a-z]{3,9})\.?\s*(\d{1,2})(?:st|nd|rd|th)?,?\s*(20\d{2})/i.exec(after);
  if (monthFirst) return monthEnd(Number(monthFirst[3]), monthOf(monthFirst[1] as string));
  const numeric = /^\s*(?:on\s+)?(\d{1,2})[./-](\d{1,2})[./-](20\d{2})/.exec(after);
  if (numeric) return monthEnd(Number(numeric[3]), Number(numeric[2]));
  return null;
}

function monthOf(name: string): number {
  return MONTHS.indexOf(name.slice(0, 3).toLowerCase()) + 1;
}

function monthEnd(year: number, month: number): string | null {
  if (month < 1 || month > 12) return null;
  return isoDate(new Date(Date.UTC(year, month, 0)));
}

function unitNear(text: string, at: number): FinancialUnit | null {
  const from = Math.max(0, at - UNIT_BEFORE);
  let before: FinancialUnit | null = null;
  for (const m of text.slice(from, at + UNIT_AFTER).matchAll(UNIT)) {
    const unit = unitOf(m[1] as string);
    if (from + m.index >= at) return unit;
    before = unit;
  }
  return before;
}

function unitOf(word: string): FinancialUnit {
  const w = word.toLowerCase();
  if (w.startsWith("cr")) return "crore";
  if (w.startsWith("la")) return "lakh";
  if (w.startsWith("m")) return "million";
  if (w.startsWith("b")) return "billion";
  return "thousand";
}

function normalize(section: string): string {
  return section
    .replace(NOTE_REF, " ")
    .replace(/\u2212/g, "-")
    .replace(/\(\s*(\d[\d,]*(?:\.\d+)?)\s*\)/g, "($1)");
}

function firstRow(section: string, label: Label): string[] | null {
  for (const m of section.matchAll(label.pattern)) {
    const row = rowTokens(section.slice(m.index + m[0].length, m.index + m[0].length + 400), label);
    if (row) return row;
  }
  return null;
}

function rowTokens(tail: string, label: Label): string[] | null {
  const words = tail.split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < words.length && !isCell(words[i] as string)) {
    if (i >= label.tailWords) return null;
    i++;
  }
  const cells: string[] = [];
  for (; i < words.length && cells.length < 4; i++) {
    const w = words[i] as string;
    if (!isCell(w) || (cells.length > 0 && NOTE.test(w) && !NUMBER.test(w))) break;
    cells.push(w);
  }
  return cells.length ? cells : null;
}

function isCell(word: string): boolean {
  return NUMBER.test(word) || NIL.test(word) || NOTE.test(word);
}

function rowValue(section: string, label: Label, layout: RowLayout): number | null {
  const row = firstRow(section, label);
  return row ? currentValue(row, layout) : 0;
}

function currentValue(row: readonly string[], layout: RowLayout): number | null {
  const [first, second] = row;
  if (first === undefined) return null;
  let cell = first;
  if (layout.noteColumn && NOTE.test(first)) {
    if (NUMBER.test(first) && row.length < layout.columns) return null;
    if (second === undefined) return null;
    cell = second;
  }
  if (NIL.test(cell)) return 0;
  return NUMBER.test(cell) ? parseIndianNumber(cell) : null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
