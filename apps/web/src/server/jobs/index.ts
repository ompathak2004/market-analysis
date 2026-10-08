import { coreJobs } from "./core";
import { insightJobs } from "./insights";
import { getJob, jobNames, registerJobs } from "./registry";
import { researchJobs } from "./research";

registerJobs(coreJobs);
registerJobs(researchJobs);
registerJobs(insightJobs);

export type { JobDef } from "./registry";
export type { JobOutcome, JobRun, JobStats } from "./run";
export { runJob } from "./run";
export { getJob, jobNames };
