import { coreJobs } from "./core";
import { getJob, jobNames, registerJobs } from "./registry";
import { researchJobs } from "./research";

registerJobs(coreJobs);
registerJobs(researchJobs);

export type { JobDef } from "./registry";
export type { JobOutcome, JobRun, JobStats } from "./run";
export { runJob } from "./run";
export { getJob, jobNames };
