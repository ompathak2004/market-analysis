import { type JobEnvelope, type JobType, LANES, laneOf, parsePayload, unitKey } from "@ma/jobs";
import { sendOptions } from "@ma/jobs/queue";
import type { PgBoss } from "pg-boss";

export const SCHEDULE_TZ = "Asia/Kolkata";

export interface ScheduleEntry {
  id: string;
  type: JobType;
  cron: string;
  payload?: Record<string, unknown>;
}

export const SCHEDULES: readonly ScheduleEntry[] = [
  { id: "universe-daily", type: "universe.fanout", cron: "30 6 * * *" },
  { id: "prices-daily", type: "prices.fanout", cron: "30 18 * * 1-5" },
  { id: "prices-repair", type: "prices.fanout", cron: "0 3 * * 6" },
  { id: "fundamentals-hourly", type: "fundamentals.fanout", cron: "10 * * * *" },
  { id: "announcements", type: "announcements.fanout", cron: "*/10 * * * *" },
  { id: "relationships", type: "relationships.fanout", cron: "20,50 * * * *" },
  { id: "intel", type: "intel.fanout", cron: "30 2,14 * * *" },
  { id: "research", type: "research.fanout", cron: "5,35 * * * *" },
  { id: "broker-fetch", type: "broker.fetch", cron: "*/15 * * * *" },
  { id: "broker-theses", type: "broker.theses", cron: "25,55 * * * *" },
  { id: "insights", type: "insights.fanout", cron: "*/10 * * * *" },
  { id: "triage", type: "triage.batch", cron: "7,22,37,52 * * * *" },
  { id: "market-brief-open", type: "market-brief", cron: "0 9 * * 1-5", payload: { slot: "open" } },
  {
    id: "market-brief-close",
    type: "market-brief",
    cron: "50 15 * * 1-5",
    payload: { slot: "close" },
  },
  { id: "aircraft-sample", type: "aircraft.sample", cron: "*/5 * * * *" },
  { id: "ais-collect", type: "ais.collect", cron: "*/10 * * * *" },
  { id: "altdata-derive", type: "altdata.derive", cron: "*/30 * * * *" },
  { id: "altdata-signals", type: "altdata.signals", cron: "15 * * * *" },
  { id: "aircraft-registry", type: "aircraft.registry", cron: "10 7 * * *" },
  { id: "fleets", type: "fleets", cron: "30 8 * * 1" },
  { id: "altdata-cleanup", type: "altdata.cleanup", cron: "20 8 * * *" },
  { id: "ops-reconcile", type: "ops.reconcile", cron: "*/15 * * * *" },
  { id: "maintenance-prune", type: "maintenance.prune", cron: "30 3 * * *" },
  { id: "ops-digest", type: "ops.digest", cron: "0 8 * * *" },
];

export function scheduleEnvelope(entry: ScheduleEntry): JobEnvelope {
  const payload = parsePayload(entry.type, entry.payload ?? {}) as Record<string, unknown>;
  return { type: entry.type, payload, campaignId: null, runId: null, attemptBase: 0, deferrals: 0 };
}

type Scheduler = Pick<PgBoss, "schedule" | "unschedule" | "getSchedules">;

export async function registerSchedules(
  boss: Scheduler,
  entries: readonly ScheduleEntry[] = SCHEDULES,
): Promise<{ registered: number; removed: number }> {
  const wanted = new Map(entries.map((e) => [`${laneOf(e.type)}/${e.id}`, e]));
  let removed = 0;
  for (const existing of await boss.getSchedules()) {
    if (!(LANES as readonly string[]).includes(existing.name)) continue;
    if (wanted.has(`${existing.name}/${existing.key}`)) continue;
    await boss.unschedule(existing.name, existing.key);
    removed++;
  }
  for (const entry of entries) {
    const envelope = scheduleEnvelope(entry);
    const key = unitKey(entry.type, envelope.payload as never);
    await boss.schedule(laneOf(entry.type), entry.cron, envelope, {
      ...sendOptions(entry.type, key),
      tz: SCHEDULE_TZ,
      key: entry.id,
      missed: "once",
    });
  }
  return { registered: entries.length, removed };
}

export async function clearSchedules(boss: Scheduler): Promise<number> {
  let removed = 0;
  for (const existing of await boss.getSchedules()) {
    if (!(LANES as readonly string[]).includes(existing.name)) continue;
    await boss.unschedule(existing.name, existing.key);
    removed++;
  }
  return removed;
}
