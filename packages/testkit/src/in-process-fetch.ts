/**
 * A `fetch` that answers from a Hono app in the same process (`app.request`), so the SPA's
 * `ApiClient` (WP0.7) and the headless journeys (WP0.8) run against the real API without a
 * server. Takes the app structurally, so the testkit never depends on `apps/api`.
 */
export interface InProcessApp {
  request(input: Request): Response | Promise<Response>;
}

export const IN_PROCESS_ORIGIN = 'http://api.in-process';

export function inProcessFetch(app: InProcessApp): typeof fetch {
  return async (input, init) => {
    const request =
      input instanceof Request
        ? new Request(input, init)
        : new Request(new URL(String(input), IN_PROCESS_ORIGIN), init);
    return app.request(request);
  };
}
