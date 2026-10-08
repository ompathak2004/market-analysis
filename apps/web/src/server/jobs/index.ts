import { altdataJobs } from "./altdata";
import { coreJobs } from "./core";
import { insightJobs } from "./insights";
import { researchJobs } from "./research";
import type { JobDef } from "./run";

const JOBS = new Map<string, JobDef>(
  [...coreJobs, ...researchJobs, ...insightJobs, ...altdataJobs].map((def) => [def.name, def]),
);

export function getJob(name: string): JobDef | undefined {
  return JOBS.get(name);
}

export function jobNames(): string[] {
  return [...JOBS.keys()];
}

export type { JobDef, JobOutcome, JobRun, JobStats } from "./run";
export { runJob } from "./run";
