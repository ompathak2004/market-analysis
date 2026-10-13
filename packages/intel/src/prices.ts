import { type Db, PRICE_BASIS, sql } from "@ma/db";

export type PriceSeries = Map<string, number>;

export type CoverageReason =
  | "no_series"
  | "rebuild_required"
  | "no_final_bars"
  | "no_calendar"
  | "stale_start"
  | "stale_end";

export interface SeriesMeta {
  generation: number;
  quality: string;
  finalThrough: string | null;
}

export interface PriceCloses {
  series: Map<number, PriceSeries>;
  meta: Map<number, SeriesMeta>;
  sessions: string[];
  today: string;
}

export type ReturnResult = { ok: true; value: number } | { ok: false; reason: CoverageReason };

export const RETURN_BASIS = { field: "adj_close", version: PRICE_BASIS.version } as const;

const ENDPOINT_TOLERANCE_SESSIONS = 1;

const IST_OFFSET_MS = 330 * 60_000;

export function istToday(now = Date.now()): string {
  return new Date(now + IST_OFFSET_MS).toISOString().slice(0, 10);
}

// Only finalized bars of the series' current adjustment generation are comparable; mixing
// generations or falling back to the unadjusted close silently changes the return basis.
export async function loadCloses(
  db: Pick<Db, "execute">,
  companyIds: number[],
  from: string,
  to: string,
  opts: { today?: string } = {},
): Promise<PriceCloses> {
  const today = opts.today ?? istToday();
  const out: PriceCloses = { series: new Map(), meta: new Map(), sessions: [], today };
  if (!companyIds.length) return out;
  const ids = sql.join(
    companyIds.map((id) => sql`${id}`),
    sql`, `,
  );
  const [states, rows, sessions] = await Promise.all([
    db.execute<{ company_id: number; g: number; q: string; final_through: string | null }>(sql`
      select s.company_id, s.adjustment_generation as g, s.quality_status as q,
             (select max(p.date)::text from prices_daily p
               where p.company_id = s.company_id and p.is_final
                 and p.adjustment_generation = s.adjustment_generation) as final_through
      from price_series_state s where s.company_id in (${ids})`),
    db.execute<{ company_id: number; date: string; adj_close: number }>(sql`
      select p.company_id, p.date::text as date, p.adj_close
      from prices_daily p
      join price_series_state s
        on s.company_id = p.company_id and s.adjustment_generation = p.adjustment_generation
      where p.company_id in (${ids}) and p.date between ${from} and ${to}
        and p.is_final and p.adj_close is not null
      order by p.date`),
    db.execute<{ date: string }>(sql`
      select date::text as date from trading_sessions
      where exchange = 'NSE' and date between ${from} and ${to} and date < ${today}
      order by date`),
  ]);
  for (const s of states)
    out.meta.set(Number(s.company_id), {
      generation: Number(s.g),
      quality: s.q,
      finalThrough: s.final_through,
    });
  for (const r of rows) {
    const id = Number(r.company_id);
    const series = out.series.get(id) ?? new Map<string, number>();
    series.set(r.date, Number(r.adj_close));
    out.series.set(id, series);
  }
  out.sessions = sessions.map((s) => s.date);
  return out;
}

export function expectedSession(sessions: string[], boundary: string): number {
  return sessions.filter((s) => s <= boundary).length - 1;
}

function endpoint(
  series: PriceSeries,
  sessions: string[],
  boundary: string,
): { close: number } | "no_calendar" | "stale" {
  const idx = expectedSession(sessions, boundary);
  if (idx < 0) return "no_calendar";
  const oldest = sessions[Math.max(0, idx - ENDPOINT_TOLERANCE_SESSIONS)] as string;
  let bar: { date: string; close: number } | null = null;
  for (const [d, c] of series) {
    if (d <= boundary) bar = { date: d, close: c };
    else break;
  }
  if (!bar || bar.date < oldest || bar.close <= 0) return "stale";
  return { close: bar.close };
}

export function seriesReturn(
  closes: PriceCloses,
  companyId: number,
  from: string,
  to: string,
): ReturnResult {
  const meta = closes.meta.get(companyId);
  if (!meta) return { ok: false, reason: "no_series" };
  if (meta.quality === "rebuild_required") return { ok: false, reason: "rebuild_required" };
  const series = closes.series.get(companyId);
  if (!series?.size) return { ok: false, reason: "no_final_bars" };
  const start = endpoint(series, closes.sessions, from);
  if (start === "no_calendar") return { ok: false, reason: "no_calendar" };
  if (start === "stale") return { ok: false, reason: "stale_start" };
  const end = endpoint(series, closes.sessions, to);
  if (end === "no_calendar") return { ok: false, reason: "no_calendar" };
  if (end === "stale") return { ok: false, reason: "stale_end" };
  return { ok: true, value: end.close / start.close - 1 };
}

export function coverageCounts(reasons: Iterable<CoverageReason>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of reasons) out[r] = (out[r] ?? 0) + 1;
  return out;
}

export function shiftDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
