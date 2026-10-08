import type { JobRun, JobStats } from "./run";

export interface JobDef {
  name: string;
  budgetMs: number;
  run: (run: JobRun) => Promise<JobStats>;
}

const registry = new Map<string, JobDef>();

export function registerJobs(defs: JobDef[]): void {
  for (const def of defs) registry.set(def.name, def);
}

export function getJob(name: string): JobDef | undefined {
  return registry.get(name);
}

export function jobNames(): string[] {
  return [...registry.keys()];
}
