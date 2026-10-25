import { createLambdaNotifier } from '../runtime/lambda';

/** Lambda entry point of the `notifier` function: async invokes from `api` and `jobs`, SNS (§5.4). */
export const handler = createLambdaNotifier(process.env);
