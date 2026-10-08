export type JsonPath = Array<string | number>;

export interface Violation {
  path: JsonPath;
  sentence: string;
  numbers: number[];
}

const NUMBER_TOKEN = /(?<![\p{L}\d_])(?<!\d[.,])\d[\d,]*(?:\.\d+)?/gu;
const EXEMPT = new Set([50, 52, 100, 200]);

export function extractNumbers(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(NUMBER_TOKEN)) {
    const raw = m[0].replace(/,(?=\d)/g, "").replace(/,+$/, "");
    const n = Number(raw);
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

const isExempt = (n: number) =>
  (Number.isInteger(n) && n <= 12) ||
  (Number.isInteger(n) && n >= 1990 && n <= 2100) ||
  EXEMPT.has(n);

export function collectInputNumbers(inputs: unknown): number[] {
  const set = new Set<number>();
  const add = (n: number) => {
    const a = Math.abs(n);
    set.add(a);
    if (a <= 1.5) set.add(a * 100);
  };
  const walk = (v: unknown) => {
    if (typeof v === "number" && Number.isFinite(v)) add(v);
    else if (typeof v === "string") for (const n of extractNumbers(v)) add(n);
    else if (Array.isArray(v)) for (const x of v) walk(x);
    else if (v && typeof v === "object") for (const x of Object.values(v)) walk(x);
  };
  walk(inputs);
  return [...set].sort((a, b) => a - b);
}

const r = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;

export function isGrounded(n: number, pool: readonly number[]): boolean {
  if (isExempt(n)) return true;
  const decimals = (String(n).split(".")[1] ?? "").length;
  const tol = Math.max(Math.abs(n) * 0.01, decimals === 0 ? 0.5 : 0.5 * 10 ** -decimals);
  let lo = 0;
  let hi = pool.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((pool[mid] as number) < n - tol) lo = mid + 1;
    else hi = mid;
  }
  for (let i = lo; i < pool.length && (pool[i] as number) <= n + tol; i++) {
    const x = pool[i] as number;
    if (r(x, 2) === r(n, 2) || r(x, decimals) === n || Math.abs(x - n) <= Math.abs(n) * 0.01)
      return true;
  }
  return false;
}

export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?;])\s+(?=[A-Z₹(\d"'])/u)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function numbersGroundedInInputs(output: unknown, inputs: unknown): Violation[] {
  const pool = collectInputNumbers(inputs);
  const out: Violation[] = [];
  const walk = (v: unknown, path: JsonPath) => {
    if (typeof v === "string") {
      for (const sentence of splitSentences(v)) {
        const bad = extractNumbers(sentence).filter((n) => !isGrounded(n, pool));
        if (bad.length) out.push({ path, sentence, numbers: bad });
      }
    } else if (Array.isArray(v)) {
      v.forEach((x, i) => {
        walk(x, [...path, i]);
      });
    } else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) if (k !== "evidence") walk(x, [...path, k]);
    }
  };
  walk(output, []);
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
    .map((v) => `- "${v.sentence}" uses ${v.numbers.join(", ")} which is not in INPUT`)
    .join("\n");
}
