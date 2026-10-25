import {
  type AddClientRequest,
  type AdminClient,
  AdminClientSchema,
  type ErrorCode,
  type MeResponse,
  MeResponseSchema,
  type Problem,
  ProblemSchema,
} from '@fisio/contracts';
import createClient, { type Middleware } from 'openapi-fetch';
import { from, map, type Observable, switchMap, take, throwError } from 'rxjs';
import type { ZodType } from 'zod';
import type { paths } from './api.generated';
import { fetchOrNetworkError } from './network-error';

/**
 * The `ApiClient` port (docs/architecture.md §7.1): one method per endpoint of §5.2, each
 * returning an Observable that performs the request when subscribed, emits the parsed response
 * once and completes, or errors with an {@link ApiError} carrying a catalogued `ErrorCode` (or a
 * `NetworkError` when the request never reached the server). View-models depend on this
 * interface; specs give them a fake whose methods return `cold()` marbles.
 */
export interface ApiClient {
  /** `GET /me`: who the caller is, by role. */
  me(): Observable<MeResponse>;
  /** `POST /admin/clients` (therapist): add a client and send the invitation. */
  addClient(input: AddClientRequest): Observable<AdminClient>;
}

/** A refused request: `code` is what view-models map to an Italian message. */
export class ApiError extends Error {
  override readonly name = 'ApiError';

  constructor(
    readonly code: ErrorCode,
    readonly status: number,
    readonly problem?: Problem,
  ) {
    super(`API answered ${status} ${code}`);
  }
}

/**
 * The header carrying the access token. One constant on purpose: CloudFront's OAC overwrites
 * `Authorization` on its way to the Function URL, and how the token reaches the Lambda is an
 * open decision (TODOS.md, "Bearer tokens through CloudFront OAC"). Locally and in-process the
 * API reads `Authorization` (§8.2).
 */
export const AUTHORIZATION_HEADER = 'authorization';
/** Required by OAC to sign a request body (§4.4); set on every request that may carry one. */
export const CONTENT_SHA256_HEADER = 'x-amz-content-sha256';

export interface OpenApiClientOptions {
  /** `globalThis.fetch` in the browser; the testkit's in-process adapter in journeys. */
  readonly fetch: typeof fetch;
  /** `/api/v1` in the browser (same origin, §4.4); an absolute URL in-process. */
  readonly baseUrl: string;
  /** A valid access token, or null when nobody is signed in: the session's `accessToken$`. */
  readonly accessToken$: Observable<string | null>;
}

/**
 * The real client: `openapi-fetch` typed from `docs/openapi.json` (`api.generated.ts`), wrapped
 * with `from()`. Every call first takes one token from `accessToken$` (which refreshes silently
 * when needed), then sends the request with the bearer and the body hash. Every endpoint here
 * needs a caller, so with no token the call fails at once as `unauthenticated` instead of
 * sending an anonymous request the API would refuse anyway. Responses are parsed with the shared
 * Zod schemas, so a server that drifts from the contract fails here, not deep in a view-model.
 */
export class OpenApiClient implements ApiClient {
  readonly #client;
  readonly #accessToken$: Observable<string | null>;

  constructor(options: OpenApiClientOptions) {
    this.#accessToken$ = options.accessToken$;
    this.#client = createClient<paths>({
      baseUrl: options.baseUrl,
      fetch: (request) => fetchOrNetworkError(options.fetch, request),
    });
    this.#client.use(bodyHashMiddleware);
  }

  me(): Observable<MeResponse> {
    return this.#call((headers) => this.#client.GET('/me', { headers }), MeResponseSchema);
  }

  addClient(input: AddClientRequest): Observable<AdminClient> {
    return this.#call(
      (headers) => this.#client.POST('/admin/clients', { headers, body: input }),
      AdminClientSchema,
    );
  }

  #call<T>(
    request: (headers: Record<string, string>) => Promise<RawResponse>,
    schema: ZodType<T>,
  ): Observable<T> {
    return this.#accessToken$.pipe(
      take(1),
      switchMap((token) =>
        token
          ? from(request({ [AUTHORIZATION_HEADER]: `Bearer ${token}` }))
          : throwError(() => new ApiError('unauthenticated', 401)),
      ),
      map((result) => schema.parse(unwrap(result))),
    );
  }
}

interface RawResponse {
  readonly data?: unknown;
  readonly error?: unknown;
  readonly response: Response;
}

/** The success body, or an {@link ApiError} from the problem+json body (or the status alone). */
function unwrap(result: RawResponse): unknown {
  if (result.response.ok && result.error === undefined) return result.data;
  const status = result.response.status;
  const problem = ProblemSchema.safeParse(result.error);
  if (problem.success) throw new ApiError(problem.data.code, status, problem.data);
  throw new ApiError('internal_error', status);
}

const bodyHashMiddleware: Middleware = {
  async onRequest({ request }) {
    if (request.method === 'GET' || request.method === 'HEAD') return request;
    const body = await request.clone().arrayBuffer();
    request.headers.set(CONTENT_SHA256_HEADER, await sha256Hex(body));
    return request;
  },
};

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
