export type JsonPath = Array<string | number>;

export type ViolationReason = "ungrounded" | "uncited";

export interface Violation {
  path: JsonPath;
  sentence: string;
  numbers: number[];
  reason: ViolationReason;
}

export type FigureUnit = "pct" | "amount" | null;

export interface NumberToken {
  value: number;
  signed: boolean;
  decimals: number;
  unit: FigureUnit;
}

export interface PoolEntry {
  value: number;
  unit: FigureUnit;
}

const NUMBER_TOKEN = /(?<![\p{L}\d_])(?<!\d[.,])(?:(?<![\d%]\s*)([+\-−]))?\d[\d,]*(?:\.\d+)?/gu;
const PCT_AFTER = /^\s*(?:%|pp\b|bps\b|per ?cent\b|percentage points?\b)/i;
const AMOUNT_AFTER =
  /^\s*(?:cr\b|crores?\b|lakhs?\b|lacs?\b|bn\b|billion\b|mn\b|million\b|trillion\b)/i;
const AMOUNT_BEFORE = /(?:₹|\brs\.?|\binr|\busd|\$)\s*$/i;

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const MONTH = MONTH_NAMES.flatMap((m) => {
  const short = m.slice(0, 3);
  return [m, short, m.toUpperCase(), short.toUpperCase(), ...(m === "September" ? ["Sept"] : [])];
})
  .sort((a, b) => b.length - a.length)
  .join("|");
const WINDOW_UNIT =
  "days?|d|weeks?|wks?|w|months?|mos?|quarters?|qtrs?|years?|yrs?|y|sessions?|hours?|hrs?|h|dma|sma|ema";

const NON_FIGURES = [
  /\b\d{4}-\d{1,2}-\d{1,2}\b/g,
  /\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/g,
  /\b\d{1,2}:\d{2}\b/g,
  new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:${MONTH})\\b`, "g"),
  new RegExp(`\\b(?:${MONTH})\\.?[\\s'’-]+\\d{1,4}\\b`, "g"),
  /\b(?:FY|CY|Q[1-4]|H[12])\s*['’]?\d{2,4}(?:\s*[-–/]\s*['’]?\d{2,4})?\b/gi,
  new RegExp(
    `(?<![\\p{L}\\d.,])\\d[\\d,]*(?:\\.\\d+)?(?:\\s*(?:-|–|to)\\s*\\d+(?:\\.\\d+)?)?[\\s-]*(?:${WINDOW_UNIT})\\b`,
    "giu",
  ),
];

export function extractTokens(text: string): NumberToken[] {
  let masked = text.replace(/\b(Rs\.?|INR|USD)(?=\d)/gi, "$1 ");
  for (const re of NON_FIGURES) masked = masked.replace(re, " ");
  const out: NumberToken[] = [];
  for (const m of masked.matchAll(NUMBER_TOKEN)) {
    const sign = m[1];
    const raw = m[0]
      .slice(sign ? 1 : 0)
      .replace(/,(?=\d)/g, "")
      .replace(/,+$/, "");
    const abs = Number(raw);
    if (!Number.isFinite(abs)) continue;
    const at = m.index ?? 0;
    const after = masked.slice(at + m[0].length, at + m[0].length + 24);
    const unit: FigureUnit = PCT_AFTER.test(after)
      ? "pct"
      : AMOUNT_AFTER.test(after) || AMOUNT_BEFORE.test(masked.slice(Math.max(0, at - 6), at))
        ? "amount"
        : null;
    const isYear = !sign && unit == null && /^\d{4}$/.test(raw) && abs >= 1990 && abs <= 2100;
    if (isYear) continue;
    out.push({
      value: sign === "-" || sign === "−" ? -abs : abs,
      signed: !!sign,
      decimals: (raw.split(".")[1] ?? "").length,
      unit,
    });
  }
  return out;
}

export interface EvidencePools {
  global: PoolEntry[];
  byId: Map<string, PoolEntry[]>;
}

export function buildPools(
  inputs: unknown,
  sections: Readonly<Record<string, unknown>> = {},
): EvidencePools {
  const global: PoolEntry[] = [];
  const byId = new Map<string, PoolEntry[]>();
  const listFor = (id: string) => {
    let list = byId.get(id);
    if (!list) {
      list = [];
      byId.set(id, list);
    }
    return list;
  };
  const push = (targets: PoolEntry[][], entry: PoolEntry) => {
    for (const t of targets) t.push(entry);
  };
  const walk = (v: unknown, key: string | null, targets: PoolEntry[][]) => {
    if (typeof v === "number" && Number.isFinite(v)) {
      const pctKey = key != null && /pct$/i.test(key);
      push(targets, { value: v, unit: pctKey ? "pct" : null });
      if (!pctKey && v !== 0 && Math.abs(v) <= 1.5) push(targets, { value: v * 100, unit: "pct" });
    } else if (typeof v === "string") {
      for (const t of extractTokens(v)) push(targets, { value: t.value, unit: t.unit });
    } else if (Array.isArray(v)) {
      for (const x of v) walk(x, null, targets);
    } else if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      const ids = [
        ...(typeof o.evidenceId === "string" ? [o.evidenceId] : []),
        ...(Array.isArray(o.evidence)
          ? o.evidence.filter((id): id is string => typeof id === "string")
          : []),
      ];
      const scoped = ids.length ? [...targets, ...ids.map(listFor)] : targets;
      for (const [k, x] of Object.entries(o)) if (k !== "evidence") walk(x, k, scoped);
    }
  };
  walk(inputs, null, [global]);
  for (const [id, value] of Object.entries(sections)) walk(value, null, [listFor(id)]);
  return { global, byId };
}

const r = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;

const unitsCompatible = (a: FigureUnit, b: FigureUnit) =>
  !((a === "pct" && b === "amount") || (a === "amount" && b === "pct"));

function matches(t: NumberToken, e: PoolEntry, tolerant: boolean): boolean {
  if (!unitsCompatible(t.unit, e.unit)) return false;
  const x = t.signed ? e.value : Math.abs(e.value);
  const n = t.value;
  if (r(x, t.decimals) === n || r(x, 2) === r(n, 2)) return true;
  return tolerant && Math.sign(x) === Math.sign(n) && Math.abs(x - n) <= Math.abs(n) * 0.01;
}

export function isGrounded(
  t: NumberToken,
  cited: readonly PoolEntry[],
  global: readonly PoolEntry[],
): boolean {
  return cited.some((e) => matches(t, e, true)) || global.some((e) => matches(t, e, false));
}

export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?;])\s+(?=[A-Z₹(\d"'+\-−])/u)
    .map((s) => s.trim())
    .filter(Boolean);
}

const claimText = (o: Record<string, unknown>): string => {
  const text = o.point ?? o.text ?? o.says;
  return typeof text === "string" ? text : "";
};

export const NO_EVIDENCE: ReadonlySet<string> = new Set();

export interface ClaimCheck {
  known: ReadonlySet<string>;
  sections?: Readonly<Record<string, unknown>>;
}

export function validateClaims(output: unknown, inputs: unknown, check: ClaimCheck): Violation[] {
  const pools = buildPools(inputs, check.sections);
  const out: Violation[] = [];
  const checkText = (text: string, path: JsonPath, cited: string[] | null) => {
    const citedPool = cited ? cited.flatMap((id) => pools.byId.get(id) ?? []) : [];
    for (const sentence of splitSentences(text)) {
      const tokens = extractTokens(sentence);
      if (!tokens.length) continue;
      if (cited && !cited.length) {
        out.push({ path, sentence, numbers: tokens.map((t) => t.value), reason: "uncited" });
        continue;
      }
      const bad = tokens.filter((t) => !isGrounded(t, citedPool, pools.global));
      if (bad.length)
        out.push({ path, sentence, numbers: bad.map((t) => t.value), reason: "ungrounded" });
    }
  };
  const walk = (v: unknown, path: JsonPath, cited: string[] | null) => {
    if (typeof v === "string") checkText(v, path, cited);
    else if (Array.isArray(v)) {
      for (const [i, x] of v.entries()) walk(x, [...path, i], cited);
    } else if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      let scope = cited;
      if (Array.isArray(o.evidence)) {
        scope = o.evidence.filter(
          (id): id is string => typeof id === "string" && check.known.has(id),
        );
        if (!scope.length && typeof path.at(-1) === "number") {
          out.push({ path, sentence: claimText(o), numbers: [], reason: "uncited" });
          return;
        }
      }
      for (const [k, x] of Object.entries(o)) if (k !== "evidence") walk(x, [...path, k], scope);
    }
  };
  walk(output, [], null);
  return out;
}

export function sanitizeEvidence<T>(
  output: T,
  known: ReadonlySet<string>,
): { output: T; removed: string[] } {
  const removed: string[] = [];
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const o: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) {
        if (k === "evidence" && Array.isArray(x)) {
          const ids = [...new Set(x.filter((id): id is string => typeof id === "string"))];
          removed.push(...ids.filter((id) => !known.has(id)));
          o[k] = ids.filter((id) => known.has(id));
        } else o[k] = walk(x);
      }
      return o;
    }
    return v;
  };
  return { output: walk(output) as T, removed };
}

export function dropViolations<T>(
  output: T,
  violations: readonly Violation[],
  droppable: ReadonlySet<string>,
): { output: T; dropped: number } {
  const clone = structuredClone(output) as Record<string, unknown>;
  const drops = new Map<string, Set<number>>();
  const scrubs: Violation[] = [];
  for (const v of violations) {
    const [head, idx] = v.path;
    if (typeof head === "string" && typeof idx === "number" && droppable.has(head)) {
      const s = drops.get(head) ?? new Set<number>();
      s.add(idx);
      drops.set(head, s);
    } else scrubs.push(v);
  }
  for (const v of scrubs) {
    const parent = v.path
      .slice(0, -1)
      .reduce<unknown>((o, k) => (o as Record<string | number, unknown>)?.[k], clone);
    const key = v.path.at(-1);
    if (parent == null || key == null) continue;
    const container = parent as Record<string | number, unknown>;
    const current = container[key];
    if (typeof current !== "string") continue;
    const kept = splitSentences(current).filter((s) => s !== v.sentence);
    container[key] = kept.join(" ");
  }
  for (const [k, idx] of drops) {
    const list = clone[k];
    if (Array.isArray(list)) clone[k] = list.filter((_, i) => !idx.has(i));
  }
  const dropped = [...drops.values()].reduce((s, x) => s + x.size, 0) + scrubs.length;
  return { output: clone as T, dropped };
}

export function describeViolations(violations: readonly Violation[]): string {
  return violations
    .slice(0, 12)
    .map((v) =>
      v.reason === "uncited"
        ? `- "${v.sentence}" cites no valid id from INPUT.evidence`
        : `- "${v.sentence}" uses ${v.numbers.join(", ")} which is not in INPUT`,
    )
    .join("\n");
}
