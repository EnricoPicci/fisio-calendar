import { OpenAPIHono } from '@hono/zod-openapi';
import type { Hono } from 'hono';
import type { ApiEnv } from './access';
import { ApiError, problemResponse, toApiError, validationError } from './problem';

export type ApiRouter = OpenAPIHono<ApiEnv>;

/** Reports an error that the response hid behind `internal_error`. */
export type ErrorLogger = (error: unknown) => void;

export const consoleErrorLogger: ErrorLogger = (error) => {
  console.error('Unexpected error while handling a request', error);
};

/**
 * An OpenAPI router whose request validation answers `validation_failed` with the rejected
 * paths, and whose errors and unknown paths answer problem+json.
 */
export function newApiRouter(log: ErrorLogger): ApiRouter {
  const router = new OpenAPIHono<ApiEnv>({
    defaultHook: (result) =>
      result.success ? undefined : problemResponse(validationError(result.target, result.error)),
  });
  installProblemHandling(router, log);
  return router;
}

/** Every thrown error and every unmatched path becomes a catalogued problem+json response. */
export function installProblemHandling<A extends Hono<ApiEnv>>(app: A, log: ErrorLogger): A {
  app.onError((error) => {
    const { apiError, unexpected } = toApiError(error);
    if (unexpected) log(error);
    return problemResponse(apiError);
  });
  app.notFound(() => problemResponse(new ApiError('not_found')));
  return app;
}
