import { chunk, MINUTE, RateLimitedError, sha256, throwIfAborted, UpstreamError } from "@ma/core";
import {
  companies,
  corporateActions,
  type Db,
  eq,
  fencedTransaction,
  indexPricesDaily,
  type ListingStatus,
  type PriceGapReason,
  type PriceQualityStatus,
  pricesDaily,
  sql,
  type Tx,
} from "@ma/db";
import type { IngestContext } from "../context.js";
import { CALENDAR_INDEX, MARKET_INDICES } from "../data/market-indices.js";
import { NSE_HISTORY_SOURCES, NseBlockedError } from "../sources/nse.js";
import {
  addDays,
  addYears,
  type DailyBar,
  type HistoryWindow,
  istToday,
  PriceValidationError,
  type RejectedBar,
  type YahooEvent,
  type YahooRange,
} from "../sources/yahoo.js";
import { seedMarketIndices } from "./universe.js";

export const PRICE_PARSER_VERSION = 1;
export const PRICE_HISTORY_YEARS = 5;
export const PRICE_CONCURRENCY = 2;
export const DAILY_LOOKBACK_SESSIONS = 10;
export const NSE_EXCHANGE = "NSE";
export const PRICE_HISTORY_BUCKET = "yahoo:history";
export const NSE_COOLDOWN_KEY = "cooldown:nse:history";
export const NSE_COOLDOWN_MS = 30 * MINUTE;

const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const UNLOOKED_GAP_RECHECK_MS = 6 * HOUR;
const MAX_GAP_BACKOFF_MS = 30 * DAY;
const NSE_OVERLAP_TOLERANCE = 5e-4;
const REFETCHABLE: PriceGapReason[] = ["missing_source_data", "invalid_bars"];

export type PriceSyncMode = "backfill" | "daily" | "repair" | "rebuild";
export type SeriesKind = "equity" | "index";

export interface PriceSeriesRef {
  seriesId: number;
  kind: SeriesKind;
  ownerId: number;
  yahooSymbol: string | null;
  nseName: string | null;
  code: string;
  desiredFrom: string;
  desiredTo: string;
  generation: number;
  qualityStatus: PriceQualityStatus;
  listedFrom: string | null;
  delistedOn: string | null;
  listingStatus: ListingStatus | null;
}

export interface PriceWindowUnit {
  seriesId: number;
  symbol: string;
  from: string;
  toExclusive: string;
  generation?: number;
}

export type PriceWindowStatus =
  | "written"
  | "stale_generation"
  | "missing_series"
  | "identity_mismatch"
  | "not_found"
  | "invalid_response"
  | "rebuild_required";

export interface PriceWindowResult {
  status: PriceWindowStatus;
  inserted: number;
  updated: number;
  unchanged: number;
  rejected: number;
  events: number;
  newActions: number;
  gaps: number;
  missingSessions: number;
  source: string | null;
  quality: PriceQualityStatus | null;
}

const emptyResult = (status: PriceWindowStatus): PriceWindowResult => ({
  status,
  inserted: 0,
  updated: 0,
  unchanged: 0,
  rejected: 0,
  events: 0,
  newActions: 0,
  gaps: 0,
  missingSessions: 0,
  source: null,
  quality: null,
});

let activeSlots = 0;
const slotWaiters: Array<() => void> = [];

export async function withPriceSlot<T>(fn: () => Promise<T>): Promise<T> {
  while (activeSlots >= PRICE_CONCURRENCY) await new Promise<void>((r) => slotWaiters.push(r));
  activeSlots++;
  try {
    return await fn();
  } finally {
    activeSlots--;
    slotWaiters.shift()?.();
  }
}

type Queryable = Pick<Db, "execute"> | Pick<Tx, "execute">;

interface SeriesRow extends Record<string, unknown> {
  id: number;
  company_id: number | null;
  index_id: number | null;
  desired_from: string;
  desired_to: string;
  adjustment_generation: number;
  quality_status: PriceQualityStatus;
  c_yahoo: string | null;
  nse_symbol: string | null;
  listed_from: string | null;
  delisted_on: string | null;
  listing_status: ListingStatus | null;
  i_code: string | null;
  i_yahoo: string | null;
}

const SERIES_SELECT = sql`
  select s.id, s.company_id, s.index_id, s.desired_from::text, s.desired_to::text,
         s.adjustment_generation, s.quality_status,
         c.yahoo_symbol as c_yahoo, c.nse_symbol, c.listed_from::text, c.delisted_on::text,
         c.listing_status, i.code as i_code, i.yahoo_symbol as i_yahoo
  from price_series_state s
  left join companies c on c.id = s.company_id
  left join indices i on i.id = s.index_id`;

function toRef(r: SeriesRow): PriceSeriesRef {
  const isIndex = r.index_id != null;
  const index = isIndex ? MARKET_INDICES.find((i) => i.code === r.i_code) : undefined;
  return {
    seriesId: Number(r.id),
    kind: isIndex ? "index" : "equity",
    ownerId: Number(isIndex ? r.index_id : r.company_id),
    yahooSymbol: isIndex ? r.i_yahoo : r.c_yahoo,
    nseName: isIndex ? (index?.nseName ?? null) : r.nse_symbol,
    code: (isIndex ? r.i_code : r.nse_symbol) ?? `series-${r.id}`,
    desiredFrom: r.desired_from,
    desiredTo: r.desired_to,
    generation: Number(r.adjustment_generation),
    qualityStatus: r.quality_status,
    listedFrom: r.listed_from,
    delistedOn: r.delisted_on,
    listingStatus: r.listing_status,
  };
}

export async function loadSeries(db: Queryable, seriesId: number): Promise<PriceSeriesRef | null> {
  const rows = await db.execute<SeriesRow>(sql`${SERIES_SELECT} where s.id = ${seriesId}`);
  return rows[0] ? toRef(rows[0]) : null;
}

export async function loadAllSeries(db: Queryable): Promise<PriceSeriesRef[]> {
  const rows = await db.execute<SeriesRow>(
    sql`${SERIES_SELECT} order by s.index_id is null, c.market_cap_cr desc nulls last, s.id`,
  );
  return rows.map(toRef);
}

export async function seriesIdFor(
  db: Queryable,
  owner: { companyId: number } | { indexId: number },
): Promise<number | null> {
  const where =
    "companyId" in owner ? sql`company_id = ${owner.companyId}` : sql`index_id = ${owner.indexId}`;
  const rows = await db.execute<{ id: number }>(
    sql`select id from price_series_state where ${where}`,
  );
  return rows[0] ? Number(rows[0].id) : null;
}

export async function latestSession(db: Queryable, onOrBefore: string): Promise<string | null> {
  const rows = await db.execute<{ d: string | null }>(sql`
    select max(date)::text as d from trading_sessions
    where exchange = ${NSE_EXCHANGE} and date <= ${onOrBefore}`);
  return rows[0]?.d ?? null;
}

export async function sessionsBack(
  db: Queryable,
  onOrBefore: string,
  n: number,
): Promise<string | null> {
  const rows = await db.execute<{ d: string }>(sql`
    select date::text as d from trading_sessions
    where exchange = ${NSE_EXCHANGE} and date <= ${onOrBefore}
    order by date desc offset ${Math.max(0, n - 1)} limit 1`);
  return rows[0]?.d ?? null;
}

export async function desiredWindow(
  db: Queryable,
  today = istToday(),
): Promise<{ from: string; to: string }> {
  const last = await latestSession(db, today);
  const finalized = last ? ((await sessionsBack(db, today, 2)) ?? addDays(last, -1)) : null;
  const to = finalized ?? addDays(today, -1);
  return { from: addYears(to, -PRICE_HISTORY_YEARS), to };
}

export function backfillWindows(desiredFrom: string, today: string): HistoryWindow[] {
  return Array.from({ length: PRICE_HISTORY_YEARS }, (_, k) => ({
    from: addYears(desiredFrom, k),
    toExclusive: k === PRICE_HISTORY_YEARS - 1 ? addDays(today, 1) : addYears(desiredFrom, k + 1),
  }));
}

export interface ListingException {
  companyId: number;
  symbol: string | null;
  reason:
    | "listing_source_unavailable"
    | "not_in_nse_equity_list"
    | "isin_mismatch"
    | "no_yahoo_symbol";
}

export async function reconcileListings(
  ctx: IngestContext,
  signal?: AbortSignal,
): Promise<{ verified: number; exceptions: ListingException[] }> {
  const rows = await ctx.db
    .select({
      id: companies.id,
      nseSymbol: companies.nseSymbol,
      isin: companies.isin,
      yahooSymbol: companies.yahooSymbol,
      listingStatus: companies.listingStatus,
    })
    .from(companies);
  const exceptions: ListingException[] = rows
    .filter((c) => !c.yahooSymbol)
    .map((c) => ({ companyId: c.id, symbol: c.nseSymbol, reason: "no_yahoo_symbol" as const }));
  let listings: Awaited<ReturnType<IngestContext["nse"]["equityListings"]>>;
  try {
    listings = await ctx.nse.equityListings();
  } catch (err) {
    ctx.logger.warn({ err }, "NSE equity list unavailable; listings stay unverified");
    return {
      verified: 0,
      exceptions: [
        ...exceptions,
        ...rows
          .filter((c) => c.yahooSymbol && c.listingStatus === "unverified")
          .map((c) => ({
            companyId: c.id,
            symbol: c.nseSymbol,
            reason: "listing_source_unavailable" as const,
          })),
      ],
    };
  }
  throwIfAborted(signal);
  const bySymbol = new Map(listings.map((l) => [l.symbol, l]));
  const updates: Array<{ id: number; listedFrom: string | null }> = [];
  for (const c of rows) {
    if (!c.nseSymbol || !c.yahooSymbol) continue;
    const l = bySymbol.get(c.nseSymbol);
    if (!l)
      exceptions.push({ companyId: c.id, symbol: c.nseSymbol, reason: "not_in_nse_equity_list" });
    else if (c.isin && l.isin && c.isin !== l.isin)
      exceptions.push({ companyId: c.id, symbol: c.nseSymbol, reason: "isin_mismatch" });
    else if (c.listingStatus === "unverified" || c.listingStatus === "active")
      updates.push({ id: c.id, listedFrom: l.listedOn });
  }
  for (const batch of chunk(updates, 200)) {
    await fencedTransaction(
      ctx.db,
      async (tx) => {
        for (const u of batch)
          await tx
            .update(companies)
            .set({ listedFrom: u.listedFrom, listingStatus: "active" })
            .where(eq(companies.id, u.id));
        await tx.execute(sql`
          update market_symbols m set verified_at = now()
          from companies c
          where m.company_id = c.id and m.verified_at is null and m.valid_to is null
            and m.provider = 'nse' and c.id in (${sql.join(
              batch.map((u) => sql`${u.id}`),
              sql`, `,
            )})`);
      },
      signal,
    );
  }
  return { verified: updates.length, exceptions };
}

export async function ensureSeriesStates(
  ctx: Pick<IngestContext, "db">,
  desired: { from: string; to: string },
  signal?: AbortSignal,
): Promise<number> {
  await seedMarketIndices(ctx);
  return fencedTransaction(
    ctx.db,
    async (tx) => {
      const states = await tx.execute(sql`
        insert into price_series_state (company_id, desired_from, desired_to)
        select id, ${desired.from}, ${desired.to} from companies where yahoo_symbol is not null
        on conflict (company_id) do update
          set desired_from = excluded.desired_from, desired_to = excluded.desired_to, updated_at = now()`);
      await tx.execute(sql`
        insert into price_series_state (index_id, desired_from, desired_to)
        select id, ${desired.from}, ${desired.to} from indices where yahoo_symbol is not null
        on conflict (index_id) do update
          set desired_from = excluded.desired_from, desired_to = excluded.desired_to, updated_at = now()`);
      for (const [provider, column] of [
        ["yahoo", "yahoo_symbol"],
        ["nse", "nse_symbol"],
      ] as const) {
        await tx.execute(sql`
          insert into market_symbols (company_id, provider, symbol, valid_from)
          select c.id, ${provider}, c.${sql.raw(column)}, coalesce(c.listed_from, ${desired.from}::date)
          from companies c
          where c.${sql.raw(column)} is not null
            and not exists (
              select 1 from market_symbols m
              where m.provider = ${provider} and m.symbol = c.${sql.raw(column)} and m.valid_to is null)
          on conflict do nothing`);
      }
      await tx.execute(sql`
        insert into market_symbols (index_id, provider, symbol, valid_from, verified_at)
        select i.id, 'yahoo', i.yahoo_symbol, ${desired.from}::date, now()
        from indices i
        where i.yahoo_symbol is not null
          and not exists (
            select 1 from market_symbols m
            where m.provider = 'yahoo' and m.symbol = i.yahoo_symbol and m.valid_to is null)
        on conflict do nothing`);
      return states.count ?? 0;
    },
    signal,
  );
}

async function symbolOwned(tx: Queryable, ref: PriceSeriesRef, symbol: string): Promise<boolean> {
  if (ref.yahooSymbol !== symbol) return false;
  const owner =
    ref.kind === "equity" ? sql`m.company_id = ${ref.ownerId}` : sql`m.index_id = ${ref.ownerId}`;
  const rows = await tx.execute<{ owned: boolean; contested: boolean }>(sql`
    select
      bool_or(${owner}) as owned,
      bool_or(not (${owner})) as contested
    from market_symbols m
    where m.provider = 'yahoo' and m.symbol = ${symbol} and m.valid_to is null`);
  return Boolean(rows[0]?.owned) && !rows[0]?.contested;
}

export interface FetchedHistory {
  bars: Array<DailyBar & { source: string }>;
  events: YahooEvent[];
  rejected: RejectedBar[];
  hash: string | null;
  source: string | null;
  detail: string | null;
}

async function nseCooldown(ctx: IngestContext): Promise<void> {
  const ttl = await ctx.redis.pttl(NSE_COOLDOWN_KEY);
  if (ttl > 0) throw new RateLimitedError("nse", ttl);
}

async function fetchNseIndex(
  ctx: IngestContext,
  nseName: string,
  window: HistoryWindow,
  signal?: AbortSignal,
): Promise<DailyBar[]> {
  await nseCooldown(ctx);
  try {
    return await withPriceSlot(() => ctx.nse.indexHistory(nseName, window, signal));
  } catch (err) {
    if (
      err instanceof NseBlockedError ||
      (err instanceof UpstreamError && /status 429/.test(err.message))
    ) {
      await ctx.redis.set(NSE_COOLDOWN_KEY, "1", "PX", NSE_COOLDOWN_MS);
      throw new RateLimitedError("nse", NSE_COOLDOWN_MS);
    }
    throw err;
  }
}

export function mergeFallback(
  primary: Array<DailyBar & { source: string }>,
  fallback: DailyBar[],
  source: string,
): { bars: Array<DailyBar & { source: string }>; added: number; mismatches: number } {
  const byDate = new Map(primary.map((b) => [b.date, b]));
  let mismatches = 0;
  for (const f of fallback) {
    const p = byDate.get(f.date);
    if (p && Math.abs(p.close / f.close - 1) > NSE_OVERLAP_TOLERANCE) mismatches++;
  }
  if (mismatches > 0) return { bars: primary, added: 0, mismatches };
  const added = fallback.filter((f) => !byDate.has(f.date)).map((f) => ({ ...f, source }));
  const bars = [...primary, ...added].sort((a, b) => a.date.localeCompare(b.date));
  return { bars, added: added.length, mismatches };
}

async function fetchHistory(
  ctx: IngestContext,
  ref: PriceSeriesRef,
  symbol: string,
  window: HistoryWindow,
  mode: PriceSyncMode,
  signal?: AbortSignal,
): Promise<FetchedHistory | null> {
  const history = await withPriceSlot(() =>
    ctx.yahoo.dailyBarsBetween(symbol, window, {
      instrumentType: ref.kind === "index" ? "INDEX" : "EQUITY",
      ...(mode === "daily" ? {} : { bucket: PRICE_HISTORY_BUCKET }),
      ...(signal ? { signal } : {}),
    }),
  );
  const yahooBars = (history?.bars ?? []).map((b) => ({ ...b, source: "yahoo" }));
  const base: FetchedHistory | null = history
    ? {
        bars: yahooBars,
        events: history.events,
        rejected: history.rejected,
        hash: history.hash,
        source: "yahoo",
        detail: null,
      }
    : null;
  const wantsFallback = !history || !yahooBars.length || mode === "repair";
  if (!wantsFallback) return base;
  if (ref.kind === "equity") {
    if (NSE_HISTORY_SOURCES.equity.verified) throw new Error("NSE equity fallback not wired");
    return base
      ? { ...base, detail: yahooBars.length ? null : "yahoo empty; NSE equity fallback unverified" }
      : null;
  }
  if (!ref.nseName) return base;
  let nse: DailyBar[];
  try {
    nse = await fetchNseIndex(ctx, ref.nseName, window, signal);
  } catch (err) {
    if (yahooBars.length && err instanceof RateLimitedError)
      return base && { ...base, detail: "nse fallback cooling down" };
    throw err;
  }
  const merged = mergeFallback(yahooBars, nse, "nse");
  if (!merged.added && !base) return null;
  return {
    bars: merged.bars,
    events: [],
    rejected: base?.rejected ?? [],
    hash: sha256(`${base?.hash ?? ""}:${JSON.stringify(nse)}`),
    source: merged.added ? (yahooBars.length ? "yahoo+nse" : "nse") : "yahoo",
    detail: merged.mismatches ? `nse overlap mismatch on ${merged.mismatches} sessions` : null,
  };
}

export async function syncPriceWindow(
  ctx: IngestContext,
  unit: PriceWindowUnit,
  mode: PriceSyncMode,
  signal?: AbortSignal,
): Promise<PriceWindowResult> {
  const ref = await loadSeries(ctx.db, unit.seriesId);
  if (!ref) return emptyResult("missing_series");
  if (unit.generation !== undefined && ref.generation > unit.generation)
    return emptyResult("stale_generation");
  if (mode === "rebuild" && unit.generation !== undefined && ref.generation >= unit.generation)
    return emptyResult("stale_generation");
  const window = { from: unit.from, toExclusive: unit.toExclusive };
  if (!(await symbolOwned(ctx.db, ref, unit.symbol))) {
    const r = await writeWindow(ctx, ref, {
      window,
      generation: unit.generation ?? ref.generation,
      fetched: null,
      hint: "unresolved_identity",
      mode,
      symbol: unit.symbol,
      signal,
    });
    return { ...r, status: "identity_mismatch" };
  }
  throwIfAborted(signal);
  let fetched: FetchedHistory | null;
  try {
    fetched = await fetchHistory(ctx, ref, unit.symbol, window, mode, signal);
  } catch (err) {
    if (!(err instanceof PriceValidationError)) throw err;
    const r = await writeWindow(ctx, ref, {
      window,
      generation: unit.generation ?? ref.generation,
      fetched: null,
      hint: "invalid_bars",
      detail: err.message,
      mode,
      symbol: unit.symbol,
      signal,
    });
    return r.status === "written" ? { ...r, status: "invalid_response" } : r;
  }
  const r = await writeWindow(ctx, ref, {
    window,
    generation: unit.generation ?? ref.generation,
    fetched,
    hint: "missing_source_data",
    mode,
    symbol: unit.symbol,
    signal,
  });
  return fetched || r.status !== "written" ? r : { ...r, status: "not_found" };
}

export async function rebuildSeries(
  ctx: IngestContext,
  unit: { seriesId: number; symbol: string; generation: number },
  signal?: AbortSignal,
  today = istToday(),
): Promise<PriceWindowResult> {
  const ref = await loadSeries(ctx.db, unit.seriesId);
  if (!ref) return emptyResult("missing_series");
  if (ref.generation + 1 !== unit.generation) return emptyResult("stale_generation");
  return syncPriceWindow(
    ctx,
    {
      seriesId: unit.seriesId,
      symbol: unit.symbol,
      from: ref.desiredFrom,
      toExclusive: addDays(today, 1),
      generation: unit.generation,
    },
    "rebuild",
    signal,
  );
}

export async function dailyWindow(db: Queryable, today = istToday()): Promise<HistoryWindow> {
  const from = (await sessionsBack(db, today, DAILY_LOOKBACK_SESSIONS)) ?? addDays(today, -15);
  return { from, toExclusive: addDays(today, 1) };
}

interface WriteInput {
  window: HistoryWindow;
  generation: number;
  fetched: FetchedHistory | null;
  hint: PriceGapReason;
  detail?: string;
  mode: PriceSyncMode;
  symbol: string;
  signal: AbortSignal | undefined;
  today?: string;
}

interface ActionDiff {
  added: YahooEvent[];
  corrected: YahooEvent[];
  hash: string;
}

const close = (a: number | null, b: number | null) =>
  a === b || (a != null && b != null && Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a)));

export function actionHash(
  actions: Array<{
    eventKey: string;
    splitNumerator: number | null;
    splitDenominator: number | null;
    cashAmount: number | null;
  }>,
): string {
  return sha256(
    [...actions]
      .sort((x, y) => x.eventKey.localeCompare(y.eventKey))
      .map(
        (a) =>
          `${a.eventKey}|${a.splitNumerator ?? ""}|${a.splitDenominator ?? ""}|${a.cashAmount ?? ""}`,
      )
      .join("\n"),
  );
}

async function upsertActions(
  tx: Tx,
  companyId: number,
  events: YahooEvent[],
  now: Date,
): Promise<ActionDiff> {
  const existing = await tx
    .select({
      eventKey: corporateActions.eventKey,
      splitNumerator: corporateActions.splitNumerator,
      splitDenominator: corporateActions.splitDenominator,
      cashAmount: corporateActions.cashAmount,
    })
    .from(corporateActions)
    .where(eq(corporateActions.companyId, companyId));
  const byKey = new Map(existing.map((a) => [a.eventKey, a]));
  const added: YahooEvent[] = [];
  const corrected: YahooEvent[] = [];
  for (const e of events) {
    const prev = byKey.get(e.eventKey);
    if (!prev) added.push(e);
    else if (
      !close(prev.splitNumerator, e.numerator) ||
      !close(prev.splitDenominator, e.denominator) ||
      !close(prev.cashAmount, e.cashAmount)
    )
      corrected.push(e);
  }
  for (const e of [...added, ...corrected]) {
    const values = {
      companyId,
      actionType: e.type,
      exDate: e.exDate,
      eventKey: e.eventKey,
      splitNumerator: e.numerator,
      splitDenominator: e.denominator,
      cashAmount: e.cashAmount,
      currency: e.currency,
      source: "yahoo",
      fetchedAt: now,
    };
    await tx
      .insert(corporateActions)
      .values(values)
      .onConflictDoUpdate({
        target: [corporateActions.companyId, corporateActions.eventKey],
        set: { ...values, correctedAt: now },
      });
    byKey.set(e.eventKey, {
      eventKey: e.eventKey,
      splitNumerator: e.numerator,
      splitDenominator: e.denominator,
      cashAmount: e.cashAmount,
    });
  }
  return { added, corrected, hash: actionHash([...byKey.values()]) };
}

export function needsRebuild(
  diff: Pick<ActionDiff, "added" | "corrected">,
  basisDay: string | null,
): boolean {
  if (diff.corrected.length) return true;
  if (basisDay === null) return false;
  return diff.added.some((e) => e.exDate >= basisDay);
}

async function writeWindow(
  ctx: IngestContext,
  ref: PriceSeriesRef,
  input: WriteInput,
): Promise<PriceWindowResult> {
  const today = input.today ?? istToday();
  const now = new Date();
  return fencedTransaction(
    ctx.db,
    async (tx) => {
      const locked = await tx.execute<{ g: number; q: PriceQualityStatus }>(sql`
        select adjustment_generation as g, quality_status as q
        from price_series_state where id = ${ref.seriesId} for update`);
      const state = locked[0];
      if (!state) return emptyResult("missing_series");
      const current = Number(state.g);
      if (current > input.generation) return emptyResult("stale_generation");
      if (input.mode === "rebuild" && current !== input.generation - 1)
        return emptyResult("stale_generation");

      const fetched = input.fetched;
      if (input.mode === "rebuild" && !fetched?.bars.length) return emptyResult("not_found");
      const result = emptyResult("written");
      result.source = fetched?.source ?? null;
      result.events = fetched?.events.length ?? 0;
      result.rejected = fetched?.rejected.length ?? 0;
      let actionHash: string | null = null;

      if (ref.kind === "equity" && fetched) {
        const diff = await upsertActions(tx, ref.ownerId, fetched.events, now);
        actionHash = diff.hash;
        result.newActions = diff.added.length + diff.corrected.length;
        if (input.mode !== "rebuild") {
          const basis = await tx.execute<{ d: string | null }>(sql`
            select (min(fetched_at) at time zone 'Asia/Kolkata')::date::text as d
            from prices_daily
            where company_id = ${ref.ownerId} and adjustment_generation = ${input.generation}`);
          if (state.q === "rebuild_required" || needsRebuild(diff, basis[0]?.d ?? null)) {
            await tx.execute(sql`
              update price_series_state
              set quality_status = 'rebuild_required', action_hash = ${actionHash},
                  checked_at = now(), updated_at = now()
              where id = ${ref.seriesId}`);
            return { ...result, status: "rebuild_required", quality: "rebuild_required" };
          }
        }
      }

      const bars = fetched?.bars ?? [];
      if (ref.kind === "index" && ref.code === CALENDAR_INDEX && bars.length) {
        const dates = bars.filter((b) => b.date <= today).map((b) => b.date);
        const source = `benchmark:${input.symbol}`;
        for (const batch of chunk(dates, 500))
          await tx.execute(sql`
            insert into trading_sessions (exchange, date, session_type, source)
            values ${sql.join(
              batch.map((d) => sql`(${NSE_EXCHANGE}, ${d}::date, 'regular', ${source})`),
              sql`, `,
            )}
            on conflict do nothing`);
      }
      // Fetched after its IST calendar day ended, a bar is the settled close for that session.
      const isFinal = (date: string) => date < today;

      for (const batch of chunk(bars, 500)) {
        const counts =
          ref.kind === "equity"
            ? await upsertEquityBars(tx, ref.ownerId, batch, input, now, isFinal)
            : await upsertIndexBars(tx, ref.ownerId, batch, input, now, isFinal);
        result.inserted += counts.inserted;
        result.updated += counts.updated;
      }
      result.unchanged = bars.length - result.inserted - result.updated;

      if (input.mode === "rebuild") {
        const table = ref.kind === "equity" ? sql`prices_daily` : sql`index_prices_daily`;
        const owner = ref.kind === "equity" ? sql`company_id` : sql`index_id`;
        await tx.execute(sql`
          delete from ${table}
          where ${owner} = ${ref.ownerId} and date >= ${ref.desiredFrom}
            and adjustment_generation <> ${input.generation}`);
      }

      if (fetched && ref.kind === "equity")
        await tx.execute(sql`
          update market_symbols set verified_at = now()
          where company_id = ${ref.ownerId} and provider = 'yahoo' and symbol = ${input.symbol}
            and valid_to is null and verified_at is null`);

      const coverage = await recomputeGaps(tx, ref, {
        generation: input.generation,
        window: input.window,
        rejected: fetched?.rejected ?? [],
        hint: fetched ? "missing_source_data" : input.hint,
        detail: fetched ? fetched.detail : (input.detail ?? "no history returned for window"),
        now,
      });
      const quality: PriceQualityStatus =
        state.q === "rebuild_required" && input.mode !== "rebuild"
          ? "rebuild_required"
          : coverage.quality;
      await tx.execute(sql`
        update price_series_state
        set adjustment_generation = ${input.generation},
            action_hash = coalesce(${actionHash}, action_hash),
            verified_through = ${coverage.verifiedThrough},
            quality_status = ${quality},
            checked_at = now(), updated_at = now()
        where id = ${ref.seriesId}`);
      return {
        ...result,
        gaps: coverage.gaps,
        missingSessions: coverage.missing,
        quality,
      };
    },
    input.signal,
  );
}

const FLOAT_TOLERANCE = 1e-5;

// Yahoo recomputes adjusted values per request; sub-tick float jitter must not count as a change.
export function changedSql(table: string, exact: string[], floats: string[]): string {
  const t = (c: string) => `"${table}".${c}`;
  const drift = floats.map(
    (c) =>
      `(${t(c)} is null) <> (excluded.${c} is null) or abs(${t(c)} - excluded.${c}) > ${FLOAT_TOLERANCE} * greatest(abs(excluded.${c}), 1)`,
  );
  const same = `(${exact.map(t).join(", ")}) is distinct from (${exact.map((c) => `excluded.${c}`).join(", ")})`;
  return [same, ...drift].join(" or ");
}

const changed = (table: string, exact: string[], floats: string[]) =>
  sql.raw(changedSql(table, exact, floats));

const PRICE_COLUMNS = ["open", "high", "low", "close"];

const BAR_COLUMNS = [
  "volume",
  "source",
  "source_symbol",
  "parser_version",
  "adjustment_generation",
  "is_final",
];

function countUpserts(rows: Array<{ inserted: boolean }>): { inserted: number; updated: number } {
  const inserted = rows.filter((r) => r.inserted).length;
  return { inserted, updated: rows.length - inserted };
}

async function upsertEquityBars(
  tx: Tx,
  companyId: number,
  bars: Array<DailyBar & { source: string }>,
  input: WriteInput,
  now: Date,
  isFinal: (date: string) => boolean,
) {
  const rows = await tx
    .insert(pricesDaily)
    .values(
      bars.map((b) => ({
        companyId,
        date: b.date,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        adjClose: b.adjClose,
        volume: b.volume,
        source: b.source,
        sourceSymbol: input.symbol,
        fetchedAt: now,
        parserVersion: PRICE_PARSER_VERSION,
        adjustmentGeneration: input.generation,
        adjustmentStatus:
          b.adjClose == null ? ("missing" as const) : ("provider_adjusted" as const),
        isFinal: isFinal(b.date),
      })),
    )
    .onConflictDoUpdate({
      target: [pricesDaily.companyId, pricesDaily.date],
      set: {
        open: sql`excluded.open`,
        high: sql`excluded.high`,
        low: sql`excluded.low`,
        close: sql`excluded.close`,
        adjClose: sql`excluded.adj_close`,
        volume: sql`excluded.volume`,
        source: sql`excluded.source`,
        sourceSymbol: sql`excluded.source_symbol`,
        fetchedAt: sql`excluded.fetched_at`,
        parserVersion: sql`excluded.parser_version`,
        adjustmentGeneration: sql`excluded.adjustment_generation`,
        adjustmentStatus: sql`excluded.adjustment_status`,
        isFinal: sql`excluded.is_final`,
      },
      setWhere: changed(
        "prices_daily",
        [...BAR_COLUMNS, "adjustment_status"],
        [...PRICE_COLUMNS, "adj_close"],
      ),
    })
    .returning({ inserted: sql<boolean>`(xmax = 0)` });
  return countUpserts(rows);
}

async function upsertIndexBars(
  tx: Tx,
  indexId: number,
  bars: Array<DailyBar & { source: string }>,
  input: WriteInput,
  now: Date,
  isFinal: (date: string) => boolean,
) {
  const rows = await tx
    .insert(indexPricesDaily)
    .values(
      bars.map((b) => ({
        indexId,
        date: b.date,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume,
        source: b.source,
        sourceSymbol: b.source === "yahoo" ? input.symbol : null,
        fetchedAt: now,
        parserVersion: PRICE_PARSER_VERSION,
        adjustmentGeneration: input.generation,
        isFinal: isFinal(b.date),
      })),
    )
    .onConflictDoUpdate({
      target: [indexPricesDaily.indexId, indexPricesDaily.date],
      set: {
        open: sql`excluded.open`,
        high: sql`excluded.high`,
        low: sql`excluded.low`,
        close: sql`excluded.close`,
        volume: sql`excluded.volume`,
        source: sql`excluded.source`,
        sourceSymbol: sql`excluded.source_symbol`,
        fetchedAt: sql`excluded.fetched_at`,
        parserVersion: sql`excluded.parser_version`,
        adjustmentGeneration: sql`excluded.adjustment_generation`,
        isFinal: sql`excluded.is_final`,
      },
      setWhere: changed("index_prices_daily", BAR_COLUMNS, PRICE_COLUMNS),
    })
    .returning({ inserted: sql<boolean>`(xmax = 0)` });
  return countUpserts(rows);
}

export interface GapRange {
  from: string;
  to: string;
  sessions: number;
  reason: PriceGapReason;
}

export function missingRanges(
  sessions: Array<{ date: string; missing: boolean }>,
  reasonOf: (date: string) => PriceGapReason,
): GapRange[] {
  const out: GapRange[] = [];
  let cur: GapRange | null = null;
  for (const s of sessions) {
    if (!s.missing) {
      cur = null;
      continue;
    }
    const reason = reasonOf(s.date);
    if (cur && cur.reason === reason) {
      cur.to = s.date;
      cur.sessions++;
    } else {
      cur = { from: s.date, to: s.date, sessions: 1, reason };
      out.push(cur);
    }
  }
  return out;
}

export function gapBackoffMs(checks: number): number {
  return Math.min(MAX_GAP_BACKOFF_MS, DAY * 2 ** Math.max(0, checks - 1));
}

interface GapContext {
  generation: number;
  window: HistoryWindow | null;
  rejected: RejectedBar[];
  hint: PriceGapReason;
  detail: string | null;
  now: Date;
}

export interface CoverageSummary {
  expected: number;
  missing: number;
  gaps: number;
  finalThrough: string | null;
  verifiedThrough: string | null;
  quality: PriceQualityStatus;
}

export async function recomputeGaps(
  tx: Tx,
  ref: PriceSeriesRef,
  ctx: GapContext,
): Promise<CoverageSummary> {
  const table = ref.kind === "equity" ? sql`prices_daily` : sql`index_prices_daily`;
  const owner = ref.kind === "equity" ? sql`company_id` : sql`index_id`;
  const start = [ref.desiredFrom, ref.listedFrom ?? ref.desiredFrom].sort().at(-1) as string;
  const end = [ref.desiredTo, ref.delistedOn ?? ref.desiredTo].sort()[0] as string;
  const sessions =
    start <= end
      ? await tx.execute<{ date: string; missing: boolean }>(sql`
          select t.date::text as date,
                 not exists (
                   select 1 from ${table} p
                   where p.${owner} = ${ref.ownerId} and p.date = t.date
                     and p.adjustment_generation = ${ctx.generation}) as missing
          from trading_sessions t
          where t.exchange = ${NSE_EXCHANGE} and t.date between ${start} and ${end}
            and not exists (
              select 1 from price_gaps g
              where g.series_id = ${ref.seriesId} and g.status = 'exempt'
                and t.date between g.from_date and g.to_date)
          order by t.date`)
      : [];
  const existing = await tx.execute<{
    from_date: string;
    to_date: string;
    reason: PriceGapReason;
    checks: number;
    next_check_at: string | null;
    detail: string | null;
  }>(sql`
    select from_date::text, to_date::text, reason, checks, next_check_at::text, detail
    from price_gaps where series_id = ${ref.seriesId} and status = 'open'`);
  const rejected = new Set(ctx.rejected.map((r) => r.date));
  const inWindow = (d: string) =>
    ctx.window !== null && d >= ctx.window.from && d < ctx.window.toExclusive;
  const priorReason = (d: string) =>
    existing.find((g) => d >= g.from_date && d <= g.to_date)?.reason ?? "missing_source_data";
  const ranges = missingRanges(sessions, (d) =>
    rejected.has(d) ? "invalid_bars" : inWindow(d) ? ctx.hint : priorReason(d),
  );

  await tx.execute(
    sql`delete from price_gaps where series_id = ${ref.seriesId} and status = 'open'`,
  );
  for (const batch of chunk(ranges, 200)) {
    const values = batch.map((g) => {
      const prev = existing.find((e) => e.from_date === g.from && e.to_date === g.to);
      const looked =
        ctx.window !== null && g.to >= ctx.window.from && g.from < ctx.window.toExclusive;
      const checks = (prev?.checks ?? 0) + (looked ? 1 : 0);
      const next = looked
        ? new Date(ctx.now.getTime() + gapBackoffMs(checks)).toISOString()
        : (prev?.next_check_at ??
          new Date(ctx.now.getTime() + UNLOOKED_GAP_RECHECK_MS).toISOString());
      const detail = looked
        ? g.reason === "invalid_bars"
          ? ctx.rejected
              .filter((r) => r.date >= g.from && r.date <= g.to)
              .map((r) => `${r.date}:${r.reason}`)
              .join(",")
          : ctx.detail
        : (prev?.detail ?? null);
      return sql`(${ref.seriesId}, ${g.from}::date, ${g.to}::date, ${g.reason}, 'open', ${g.sessions},
        ${checks}, ${next}::timestamptz, ${detail})`;
    });
    await tx.execute(sql`
      insert into price_gaps (series_id, from_date, to_date, reason, status, sessions, checks, next_check_at, detail)
      values ${sql.join(values, sql`, `)}
      on conflict (series_id, from_date, to_date) do nothing`);
  }

  const fin = await tx.execute<{ d: string | null }>(sql`
    select max(date)::text as d from ${table}
    where ${owner} = ${ref.ownerId} and adjustment_generation = ${ctx.generation} and is_final`);
  const finalThrough = fin[0]?.d ?? null;
  const missing = ranges.reduce((s, g) => s + g.sessions, 0);
  const firstMissing = ranges[0]?.from ?? null;
  let verifiedThrough = finalThrough;
  if (firstMissing) {
    const before = sessions.filter((s) => s.date < firstMissing).at(-1)?.date ?? null;
    verifiedThrough = before && finalThrough ? ([before, finalThrough].sort()[0] as string) : null;
  }
  const unverifiedListing =
    ref.kind === "equity" &&
    (ref.listingStatus === "unverified" || ref.listingStatus === "placeholder");
  const quality: PriceQualityStatus =
    missing === 0 && sessions.length > 0 && finalThrough !== null && finalThrough >= end
      ? "complete"
      : unverifiedListing || ranges.some((g) => g.reason === "unresolved_identity")
        ? "exception"
        : "partial";
  return {
    expected: sessions.length,
    missing,
    gaps: ranges.length,
    finalThrough,
    verifiedThrough,
    quality,
  };
}

export async function reconcileSeries(
  ctx: Pick<IngestContext, "db">,
  seriesId: number,
  signal?: AbortSignal,
): Promise<CoverageSummary | null> {
  return fencedTransaction(
    ctx.db,
    async (tx) => {
      const locked = await tx.execute<{ q: PriceQualityStatus }>(sql`
        select quality_status as q from price_series_state where id = ${seriesId} for update`);
      if (!locked[0]) return null;
      const ref = await loadSeries(tx, seriesId);
      if (!ref) return null;
      const summary = await recomputeGaps(tx, ref, {
        generation: ref.generation,
        window: null,
        rejected: [],
        hint: "missing_source_data",
        detail: null,
        now: new Date(),
      });
      const quality = locked[0].q === "rebuild_required" ? "rebuild_required" : summary.quality;
      await tx.execute(sql`
        update price_series_state
        set verified_through = ${summary.verifiedThrough}, quality_status = ${quality},
            checked_at = now(), updated_at = now()
        where id = ${seriesId}`);
      return summary;
    },
    signal,
  );
}

export interface BackfillUnit {
  seriesId: number;
  symbol: string;
  from: string;
  toExclusive: string;
  generation: number;
  parserVersion: number;
}

export interface BackfillManifest {
  units: BackfillUnit[];
  series: number;
  exceptions: ListingException[];
  desired: { from: string; to: string };
}

export async function buildBackfillManifest(
  ctx: IngestContext,
  opts: { today?: string; signal?: AbortSignal } = {},
): Promise<BackfillManifest> {
  const today = opts.today ?? istToday();
  const listing = await reconcileListings(ctx, opts.signal);
  const desired = await desiredWindow(ctx.db, today);
  await ensureSeriesStates(ctx, desired, opts.signal);
  const series = await loadAllSeries(ctx.db);
  const units: BackfillUnit[] = [];
  for (const s of series) {
    if (!s.yahooSymbol) continue;
    const generation = Math.max(1, s.generation);
    for (const w of backfillWindows(desired.from, today))
      units.push({
        seriesId: s.seriesId,
        symbol: s.yahooSymbol,
        from: w.from,
        toExclusive: w.toExclusive,
        generation,
        parserVersion: PRICE_PARSER_VERSION,
      });
  }
  return { units, series: series.length, exceptions: listing.exceptions, desired };
}

export interface DailyUnit {
  seriesId: number;
  symbol: string;
  date: string;
}

export async function buildDailyManifest(
  ctx: Pick<IngestContext, "db">,
  opts: { today?: string; signal?: AbortSignal } = {},
): Promise<{ equities: DailyUnit[]; indices: DailyUnit[]; rebuilds: RebuildUnit[] }> {
  const today = opts.today ?? istToday();
  await ensureSeriesStates(ctx, await desiredWindow(ctx.db, today), opts.signal);
  const series = await loadAllSeries(ctx.db);
  const polled = series.filter(
    (s) =>
      s.yahooSymbol &&
      s.qualityStatus !== "rebuild_required" &&
      (s.kind === "index" ||
        (s.listingStatus !== "placeholder" &&
          !(s.listingStatus === "delisted" && s.delistedOn && s.delistedOn < today))),
  );
  const unit = (s: PriceSeriesRef): DailyUnit => ({
    seriesId: s.seriesId,
    symbol: s.yahooSymbol as string,
    date: today,
  });
  return {
    indices: polled.filter((s) => s.kind === "index").map(unit),
    equities: polled.filter((s) => s.kind === "equity").map(unit),
    rebuilds: rebuildUnits(series),
  };
}

export interface RebuildUnit {
  seriesId: number;
  symbol: string;
  generation: number;
  parserVersion: number;
}

function rebuildUnits(series: PriceSeriesRef[]): RebuildUnit[] {
  return series
    .filter((s) => s.qualityStatus === "rebuild_required" && s.yahooSymbol)
    .map((s) => ({
      seriesId: s.seriesId,
      symbol: s.yahooSymbol as string,
      generation: s.generation + 1,
      parserVersion: PRICE_PARSER_VERSION,
    }));
}

export interface RepairManifest {
  reconciled: number;
  refetch: BackfillUnit[];
  rebuilds: RebuildUnit[];
  openGaps: number;
}

export async function buildRepairManifest(
  ctx: Pick<IngestContext, "db">,
  opts: { limit: number; signal?: AbortSignal; deadline?: () => boolean },
): Promise<RepairManifest> {
  const series = await loadAllSeries(ctx.db);
  let reconciled = 0;
  for (const s of series) {
    if (opts.deadline?.()) break;
    throwIfAborted(opts.signal);
    if (await reconcileSeries(ctx, s.seriesId, opts.signal)) reconciled++;
  }
  const due = await ctx.db.execute<{
    series_id: number;
    from_date: string;
    to_date: string;
    generation: number;
  }>(sql`
    select g.series_id, g.from_date::text, g.to_date::text, s.adjustment_generation as generation
    from price_gaps g join price_series_state s on s.id = g.series_id
    where g.status = 'open' and g.reason in (${sql.join(
      REFETCHABLE.map((r) => sql`${r}`),
      sql`, `,
    )})
      and s.quality_status <> 'rebuild_required'
      and (g.next_check_at is null or g.next_check_at <= now())
    order by g.next_check_at nulls first, g.series_id
    limit ${opts.limit}`);
  const bySeries = new Map(series.map((s) => [s.seriesId, s]));
  const refetch = due.flatMap((g) => {
    const s = bySeries.get(Number(g.series_id));
    if (!s?.yahooSymbol) return [];
    return [
      {
        seriesId: s.seriesId,
        symbol: s.yahooSymbol,
        from: g.from_date,
        toExclusive: addDays(g.to_date, 1),
        generation: Number(g.generation),
        parserVersion: PRICE_PARSER_VERSION,
      },
    ];
  });
  if (refetch.length)
    await fencedTransaction(
      ctx.db,
      (tx) =>
        tx.execute(sql`
          update price_gaps set next_check_at = now() + interval '6 hours', updated_at = now()
          where status = 'open' and (series_id, from_date) in (${sql.join(
            refetch.map((u) => sql`(${u.seriesId}, ${u.from}::date)`),
            sql`, `,
          )})`),
      opts.signal,
    );
  const open = await ctx.db.execute<{ n: number }>(
    sql`select count(*)::int as n from price_gaps where status = 'open'`,
  );
  const fresh = await loadAllSeries(ctx.db);
  return {
    reconciled,
    refetch,
    rebuilds: rebuildUnits(fresh),
    openGaps: Number(open[0]?.n ?? 0),
  };
}

const RANGE_DAYS: Record<YahooRange, number> = {
  "5d": 7,
  "1mo": 31,
  "3mo": 92,
  "6mo": 183,
  "1y": 366,
  "2y": 731,
  "5y": 1827,
  max: 1827,
};

export async function syncPrices(
  ctx: IngestContext,
  companyId: number,
  range: YahooRange = "1y",
  signal?: AbortSignal,
): Promise<number> {
  const company = await ctx.db.query.companies.findFirst({ where: eq(companies.id, companyId) });
  if (!company?.yahooSymbol) return 0;
  let seriesId = await seriesIdFor(ctx.db, { companyId });
  if (seriesId === null) {
    await ensureSeriesStates(ctx, await desiredWindow(ctx.db), signal);
    seriesId = await seriesIdFor(ctx.db, { companyId });
  }
  if (seriesId === null) return 0;
  const today = istToday();
  const ref = await loadSeries(ctx.db, seriesId);
  const r = await syncPriceWindow(
    ctx,
    {
      seriesId,
      symbol: company.yahooSymbol,
      from: addDays(today, -RANGE_DAYS[range]),
      toExclusive: addDays(today, 1),
      generation: ref?.generation ?? 0,
    },
    RANGE_DAYS[range] > 366 ? "backfill" : "daily",
    signal,
  );
  return r.inserted + r.updated + r.unchanged;
}
