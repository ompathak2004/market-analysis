import { JOB_TYPES, laneOf } from "@ma/jobs";
import { PgBoss } from "pg-boss";
import { describe, expect, it } from "vitest";
import { FAMILY_ALIASES, resolveJob } from "./cli.js";
import { HANDLERS } from "./handlers/index.js";
import {
  registerSchedules,
  SCHEDULE_TZ,
  SCHEDULES,
  scheduleEnvelope,
  scheduleId,
} from "./schedules.js";

describe("schedules", () => {
  it("uses unique ids and valid crons in IST", () => {
    const ids = SCHEDULES.map(scheduleId);
    expect(new Set(ids).size).toBe(ids.length);
    const boss = new PgBoss({ connectionString: "postgres://localhost/unused" });
    for (const entry of SCHEDULES) {
      const next = boss.previewSchedule(entry.cron, { tz: SCHEDULE_TZ, count: 2 });
      expect(next, scheduleId(entry)).toHaveLength(2);
      expect(() => scheduleEnvelope(entry)).not.toThrow();
    }
  });

  it("registers schedules on lane queues and removes stale ones", async () => {
    const calls: { name: string; key: string | undefined }[] = [];
    const removed: string[] = [];
    const boss = {
      getSchedules: async () => [
        { name: "io", key: "retired-job" },
        { name: laneOf("prices.fanout"), key: "prices.daily" },
      ],
      schedule: async (name: string, _cron: string, _data: unknown, opts: { key?: string }) => {
        calls.push({ name, key: opts.key });
      },
      unschedule: async (name: string, key: string) => {
        removed.push(`${name}/${key}`);
      },
    };
    const result = await registerSchedules(boss as never);
    expect(result).toEqual({ registered: SCHEDULES.length, removed: 1 });
    expect(removed).toEqual(["io/retired-job"]);
    expect(calls).toContainEqual({ name: laneOf("prices.fanout"), key: "prices.daily" });
    removed.length = 0;
    expect(await registerSchedules(boss as never, [])).toEqual({ registered: 0, removed: 2 });
  });
});

describe("handlers and CLI aliases", () => {
  it("has a handler for every job type", () => {
    for (const type of JOB_TYPES) expect(typeof HANDLERS[type], type).toBe("function");
  });

  it("maps legacy job names onto worker job types", () => {
    for (const name of Object.keys(FAMILY_ALIASES)) expect(() => resolveJob(name)).not.toThrow();
    expect(resolveJob("prices")).toEqual({ type: "prices.fanout", payload: {} });
    expect(resolveJob("prices.sync", '{"companyId":3}')).toEqual({
      type: "prices.sync",
      payload: { companyId: 3 },
    });
    expect(() => resolveJob("nope")).toThrow(/unknown job/);
  });
});
