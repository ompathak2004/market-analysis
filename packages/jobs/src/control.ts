import { type Db, eq, jobControl } from "@ma/db";

export const JOB_MODES = ["paused", "worker"] as const;
export type JobMode = (typeof JOB_MODES)[number];

export function isJobMode(value: string): value is JobMode {
  return (JOB_MODES as readonly string[]).includes(value);
}

export async function getJobMode(db: Db): Promise<JobMode> {
  const [row] = await db
    .select({ mode: jobControl.mode })
    .from(jobControl)
    .where(eq(jobControl.id, 1))
    .limit(1);
  return row?.mode ?? "paused";
}

export async function setJobMode(db: Db, mode: JobMode): Promise<void> {
  await db
    .insert(jobControl)
    .values({ id: 1, mode, updatedAt: new Date() })
    .onConflictDoUpdate({ target: jobControl.id, set: { mode, updatedAt: new Date() } });
}
