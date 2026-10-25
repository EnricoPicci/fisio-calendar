import { handle } from 'hono/aws-lambda';
import { createLambdaApp } from '../runtime/lambda';

/** Lambda entry point of the `api` function, behind its Function URL (§4.4). */
export const handler = handle(createLambdaApp(process.env).app);
