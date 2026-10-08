import { median } from "@ma/intel";

export interface TargetStats {
  count: number;
  low: number | null;
  high: number | null;
  mean: number | null;
  median: number | null;
}

export function targetStats(targets: readonly (number | null)[]): TargetStats {
  const t = targets.filter((x): x is number => x != null && x > 0).sort((a, b) => a - b);
  return {
    count: t.length,
    low: t[0] ?? null,
    high: t.at(-1) ?? null,
    mean: t.length ? t.reduce((s, x) => s + x, 0) / t.length : null,
    median: median(t),
  };
}
