import { altdataEvents, and, type Db, eq, inArray, signals, sql } from "@ma/db";
import type { AltdataSignal } from "./types.js";

export const DAY_MS = 86_400_000;
export const READ_MAX = 240;

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export function round(v: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

export function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function fitRead(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= READ_MAX ? t : `${t.slice(0, READ_MAX - 1).trimEnd()}…`;
}

export function meanStd(values: number[]): { mean: number; std: number } {
  if (!values.length) return { mean: 0, std: 0 };
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  if (values.length < 2) return { mean, std: 0 };
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1);
  return { mean, std: Math.sqrt(variance) };
}

export function zScore(value: number, mean: number, std: number): number {
  if (std > 0) return (value - mean) / std;
  return value === mean ? 0 : (value - mean) / Math.max(1, Math.sqrt(Math.max(mean, 1)));
}

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

export function weekCounts(times: number[], endMs: number, weeks: number): number[] {
  const out = new Array<number>(weeks).fill(0);
  for (const t of times) {
    const idx = Math.floor((endMs - t) / (7 * DAY_MS));
    if (idx >= 0 && idx < weeks) out[weeks - 1 - idx] = (out[weeks - 1 - idx] as number) + 1;
  }
  return out;
}

export function formatDay(ms: number): string {
  return new Date(ms).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "Asia/Kolkata",
  });
}

export async function writeAltdataSignals(
  db: Db,
  companyId: number,
  asOf: string,
  allKinds: readonly string[],
  rows: AltdataSignal[],
  modelVersion: number,
): Promise<number> {
  const kinds = rows.map((r) => r.kind);
  await db
    .delete(signals)
    .where(
      and(
        eq(signals.companyId, companyId),
        eq(signals.asOf, asOf),
        inArray(signals.kind, [...allKinds]),
        kinds.length ? sql`${signals.kind} not in ${kinds}` : undefined,
      ),
    );
  if (!rows.length) return 0;
  await db
    .insert(signals)
    .values(
      rows.map((r) => ({
        companyId,
        asOf,
        kind: r.kind,
        value: r.value ?? 0,
        inputs: r.inputs as unknown as Record<string, unknown>,
        modelVersion,
      })),
    )
    .onConflictDoUpdate({
      target: [signals.companyId, signals.asOf, signals.kind],
      set: {
        value: sql`excluded.value`,
        inputs: sql`excluded.inputs`,
        modelVersion: sql`excluded.model_version`,
      },
    });
  return rows.length;
}

export interface AltdataEventInput {
  layer: "air" | "sea";
  kind: string;
  companyId: number | null;
  facilityId?: number | null;
  occurredAt: number;
  headline: string;
  detail: Record<string, unknown>;
  severity: number;
  dedupeKey: string;
}

export async function emitAltdataEvents(db: Db, events: AltdataEventInput[]): Promise<number> {
  const unique = [...new Map(events.map((e) => [e.dedupeKey, e])).values()];
  if (!unique.length) return 0;
  const rows = await db
    .insert(altdataEvents)
    .values(
      unique.map((e) => ({
        layer: e.layer,
        kind: e.kind,
        companyId: e.companyId,
        facilityId: e.facilityId ?? null,
        occurredAt: new Date(e.occurredAt),
        headline: fitRead(e.headline),
        detail: e.detail,
        severity: e.severity,
        dedupeKey: e.dedupeKey,
      })),
    )
    .onConflictDoUpdate({
      target: altdataEvents.dedupeKey,
      set: { headline: sql`excluded.headline`, detail: sql`excluded.detail` },
    })
    .returning({ id: altdataEvents.id });
  return rows.length;
}
