import { type JobEnvelope, type JobType, LANES, laneOf, parsePayload, unitKey } from "@ma/jobs";
import { sendOptions } from "@ma/jobs/queue";
import type { PgBoss } from "pg-boss";

export const SCHEDULE_TZ = "Asia/Kolkata";

export interface ScheduleEntry {
  type: JobType;
  cron: string;
  id?: string;
  payload?: Record<string, unknown>;
}

export const SCHEDULES: readonly ScheduleEntry[] = [
  { type: "universe.fanout", cron: "30 6 * * *" },
  { type: "prices.fanout", cron: "30 18 * * *", id: "prices.daily" },
  { type: "prices.fanout", cron: "15 8 * * *", id: "prices.catchup" },
  { type: "prices.repair", cron: "0 3 * * *" },
  { type: "fundamentals.fanout", cron: "10 * * * *" },
  { type: "announcements.fanout", cron: "*/10 * * * *" },
  { type: "relationships.fanout", cron: "20,50 * * * *" },
  { type: "relationships.counterparties", cron: "30 2 * * *" },
  { type: "orders.fanout", cron: "30 7 * * *" },
  { type: "ratings.fanout", cron: "45 7 * * *" },
  { type: "presentations.fanout", cron: "0 8 * * *" },
  { type: "relationships.llm", cron: "0 5 * * *" },
  { type: "relationships.facts.fanout", cron: "0 1 * * 0" },
  { type: "relationships.priors", cron: "0 2 * * 0" },
  { type: "intel.fanout", cron: "30 2,14 * * *" },
  { type: "research.fanout", cron: "5,35 * * * *" },
  { type: "broker.fetch", cron: "*/15 * * * *" },
  { type: "broker.theses", cron: "25,55 * * * *" },
  { type: "insights.fanout", cron: "*/10 * * * *" },
  { type: "triage.batch", cron: "7,22,37,52 * * * *" },
  { type: "market-brief", cron: "0 9 * * 1-5", id: "market-brief.open", payload: { slot: "open" } },
  {
    type: "market-brief",
    cron: "50 15 * * 1-5",
    id: "market-brief.close",
    payload: { slot: "close" },
  },
  { type: "aircraft.sample", cron: "*/5 * * * *" },
  { type: "ais.collect", cron: "*/10 * * * *" },
  { type: "altdata.derive", cron: "*/30 * * * *" },
  { type: "altdata.signals", cron: "15 * * * *" },
  { type: "aircraft.registry", cron: "10 7 * * *" },
  { type: "fleets", cron: "30 8 * * 1" },
  { type: "altdata.cleanup", cron: "20 8 * * *" },
  { type: "ops.reconcile", cron: "*/15 * * * *" },
  { type: "maintenance.prune", cron: "30 3 * * *" },
  { type: "ops.digest", cron: "0 8 * * *" },
  { type: "documents.snapshot", cron: "45 * * * *" },
  { type: "documents.release", cron: "40 4 * * *" },
  { type: "documents.gc", cron: "50 4 * * *" },
  { type: "influence.governance.fanout", cron: "0 3 * * 0" },
  { type: "influence.rpt.fanout", cron: "30 3 * * 0" },
  { type: "influence.perimeter.fanout", cron: "0 4 * * 0" },
  { type: "influence.parliament", cron: "30 4 * * 0" },
  { type: "influence.affidavits", cron: "0 5 1 * *" },
  { type: "influence.sectors", cron: "30 5 * * 0" },
  { type: "influence.policy.pib", cron: "25 * * * *" },
  { type: "influence.policy.prs", cron: "15 6 * * *" },
  { type: "influence.policy.gazette", cron: "45 6 * * *" },
  { type: "influence.policy.tag", cron: "55 * * * *" },
];

export function scheduleId(entry: ScheduleEntry): string {
  return entry.id ?? entry.type;
}

export function scheduleEnvelope(entry: ScheduleEntry): JobEnvelope {
  const payload = parsePayload(entry.type, entry.payload ?? {}) as Record<string, unknown>;
  return { type: entry.type, payload, campaignId: null, runId: null, attemptBase: 0, deferrals: 0 };
}

type Scheduler = Pick<PgBoss, "schedule" | "unschedule" | "getSchedules">;

export async function registerSchedules(
  boss: Scheduler,
  entries: readonly ScheduleEntry[] = SCHEDULES,
): Promise<{ registered: number; removed: number }> {
  const wanted = new Set(entries.map((e) => `${laneOf(e.type)}/${scheduleId(e)}`));
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
      key: scheduleId(entry),
      missed: "once",
    });
  }
  return { registered: entries.length, removed };
}
