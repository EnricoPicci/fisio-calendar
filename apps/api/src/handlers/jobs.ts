import { createLambdaJobs } from '../runtime/lambda';

/** Lambda entry point of the `jobs` function, run by EventBridge Scheduler every 15 minutes (§5.3). */
export const handler = createLambdaJobs(process.env);
