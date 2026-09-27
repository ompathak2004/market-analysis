import { and, asc, type Db, gte, inArray, lte, pricesDaily } from "@ma/db";

export type PriceSeries = Map<string, number>;

export async function loadCloses(
  db: Db,
  companyIds: number[],
  from: string,
  to: string,
): Promise<Map<number, PriceSeries>> {
  const out = new Map<number, PriceSeries>();
  if (!companyIds.length) return out;
  const rows = await db
    .select({
      companyId: pricesDaily.companyId,
      date: pricesDaily.date,
      close: pricesDaily.adjClose,
      raw: pricesDaily.close,
    })
    .from(pricesDaily)
    .where(
      and(
        inArray(pricesDaily.companyId, companyIds),
        gte(pricesDaily.date, from),
        lte(pricesDaily.date, to),
      ),
    )
    .orderBy(asc(pricesDaily.date));
  for (const r of rows) {
    const series = out.get(r.companyId) ?? new Map<string, number>();
    series.set(r.date, r.close ?? r.raw);
    out.set(r.companyId, series);
  }
  return out;
}

export function closeOnOrBefore(series: PriceSeries, date: string): number | null {
  let best: number | null = null;
  for (const [d, c] of series) {
    if (d <= date) best = c;
    else break;
  }
  return best;
}

export function totalReturn(series: PriceSeries, from: string, to: string): number | null {
  const p0 = closeOnOrBefore(series, from);
  const p1 = closeOnOrBefore(series, to);
  if (p0 == null || p1 == null || p0 <= 0) return null;
  return p1 / p0 - 1;
}

export function shiftDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
