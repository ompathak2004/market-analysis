export interface OlsResult {
  coefficients: number[];
  standardErrors: number[];
  tStats: number[];
  r2: number;
  adjR2: number;
  rmse: number;
  aic: number;
  n: number;
  k: number;
}

export function ols(X: number[][], y: number[]): OlsResult {
  const n = y.length;
  const k = (X[0]?.length ?? 0) + 1;
  if (n <= k) throw new Error(`OLS needs more observations (${n}) than parameters (${k})`);
  const A = X.map((row) => [1, ...row]);
  const XtX = matMul(transpose(A), A);
  const Xty = matVec(transpose(A), y);
  const XtXInv = invert(XtX);
  const beta = matVec(XtXInv, Xty);
  const fitted = matVec(A, beta);
  const residuals = y.map((v, i) => v - (fitted[i] as number));
  const sse = residuals.reduce((s, r) => s + r * r, 0);
  const mean = y.reduce((s, v) => s + v, 0) / n;
  const sst = y.reduce((s, v) => s + (v - mean) ** 2, 0);
  const r2 = sst === 0 ? 0 : 1 - sse / sst;
  const dof = n - k;
  const sigma2 = sse / dof;
  const standardErrors = beta.map((_, i) => Math.sqrt(Math.max(0, sigma2 * (XtXInv[i]?.[i] ?? 0))));
  return {
    coefficients: beta,
    standardErrors,
    tStats: beta.map((b, i) =>
      (standardErrors[i] ?? 0) === 0 ? 0 : b / (standardErrors[i] as number),
    ),
    r2,
    adjR2: 1 - ((1 - r2) * (n - 1)) / dof,
    rmse: Math.sqrt(sse / n),
    aic: n * Math.log(sse / n) + 2 * k,
    n,
    k,
  };
}

export function zScores(values: Array<number | null>): Array<number | null> {
  const present = values.filter((v): v is number => v != null && Number.isFinite(v));
  if (present.length < 2) return values.map(() => null);
  const mean = present.reduce((s, v) => s + v, 0) / present.length;
  const sd = Math.sqrt(present.reduce((s, v) => s + (v - mean) ** 2, 0) / (present.length - 1));
  return values.map((v) => (v == null || !Number.isFinite(v) || sd === 0 ? null : (v - mean) / sd));
}

export function logistic(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

export function hhi(shares: number[]): number {
  return shares.reduce((s, v) => s + v * v, 0);
}

function transpose(m: number[][]): number[][] {
  return (m[0] ?? []).map((_, j) => m.map((row) => row[j] as number));
}

function matMul(a: number[][], b: number[][]): number[][] {
  return a.map((row) =>
    (b[0] ?? []).map((_, j) => row.reduce((s, v, i) => s + v * (b[i]?.[j] as number), 0)),
  );
}

function matVec(a: number[][], v: number[]): number[] {
  return a.map((row) => row.reduce((s, x, i) => s + x * (v[i] as number), 0));
}

function invert(m: number[][]): number[][] {
  const n = m.length;
  const a = m.map((row, i) => [...row, ...row.map((_, j) => (i === j ? 1 : 0))]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(a[r]?.[col] as number) > Math.abs(a[pivot]?.[col] as number)) pivot = r;
    }
    const pivotRow = a[pivot] as number[];
    if (Math.abs(pivotRow[col] as number) < 1e-12) throw new Error("singular matrix");
    [a[col], a[pivot]] = [pivotRow, a[col] as number[]];
    const cur = a[col] as number[];
    const p = cur[col] as number;
    for (let j = 0; j < 2 * n; j++) cur[j] = (cur[j] as number) / p;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const row = a[r] as number[];
      const f = row[col] as number;
      if (f === 0) continue;
      for (let j = 0; j < 2 * n; j++) row[j] = (row[j] as number) - f * (cur[j] as number);
    }
  }
  return a.map((row) => row.slice(n));
}
