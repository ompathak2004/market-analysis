import { altdataJobs } from "./altdata";
import { coreJobs } from "./core";
import { getJob, jobNames, registerJobs } from "./registry";

registerJobs(coreJobs);
registerJobs(altdataJobs);

export type { JobDef } from "./registry";
export type { JobOutcome, JobRun, JobStats } from "./run";
export { runJob } from "./run";
export { getJob, jobNames };
