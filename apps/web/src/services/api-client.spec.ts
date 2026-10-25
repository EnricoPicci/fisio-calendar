import { PROBLEM_MEDIA_TYPE } from '@fisio/contracts';
import { firstValueFrom, of, Subject } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { ApiError, AUTHORIZATION_HEADER, CONTENT_SHA256_HEADER, OpenApiClient } from './api-client';
import { NetworkError } from './network-error';

const BASE_URL = 'http://api.test/api/v1';
const clientProfile = {
  role: 'client',
  clientId: '6f1d2c3b-4a5e-4f60-8b7c-9d0e1f2a3b4c',
  name: 'Giulia Bianchi',
  email: 'giulia.bianchi@fisio.test',
  locale: 'it',
};
const addClient = { name: 'Marco Rossi', email: 'marco.rossi@fisio.test' };
const adminClient = {
  clientId: '7f1d2c3b-4a5e-4f60-8b7c-9d0e1f2a3b4c',
  ...addClient,
  status: 'invited',
  createdAt: '2027-03-01T08:00:00.000Z',
};

/** A `fetch` that records every request and answers with what the spec decided. */
function fakeFetch(answer: (request: Request) => Response | Promise<Response>) {
  const requests: Request[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    requests.push(request);
    return answer(request);
  };
  return { fetch, requests };
}

const json = (status: number, body: unknown, type = 'application/json') =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': type } });

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

describe('ApiClient: typed requests with the bearer token and the OAC body hash (architecture §4.4, §7.1)', () => {
  it('sends the bearer token taken from accessToken$; a GET carries no body hash', async () => {
    const { fetch, requests } = fakeFetch(() => json(200, clientProfile));
    const client = new OpenApiClient({ fetch, baseUrl: BASE_URL, accessToken$: of('tok-123') });

    const me = await firstValueFrom(client.me());

    expect(me).toMatchObject({ role: 'client', name: 'Giulia Bianchi' });
    const request = requests[0];
    expect(request?.method).toBe('GET');
    expect(request?.url).toBe(`${BASE_URL}/me`);
    expect(request?.headers.get(AUTHORIZATION_HEADER)).toBe('Bearer tok-123');
    expect(request?.headers.get(CONTENT_SHA256_HEADER)).toBeNull();
  });

  it('a request with a body carries x-amz-content-sha256, the SHA-256 of the body sent', async () => {
    const { fetch, requests } = fakeFetch(() => json(201, adminClient));
    const client = new OpenApiClient({ fetch, baseUrl: BASE_URL, accessToken$: of('tok') });

    const created = await firstValueFrom(client.addClient(addClient));

    expect(created).toMatchObject({ status: 'invited', email: 'marco.rossi@fisio.test' });
    const request = requests[0];
    expect(request?.method).toBe('POST');
    expect(request?.headers.get('content-type')).toBe('application/json');
    const body = await request?.clone().text();
    expect(JSON.parse(body ?? '')).toEqual(addClient);
    expect(request?.headers.get(CONTENT_SHA256_HEADER)).toBe(await sha256Hex(body ?? ''));
  });

  it('nobody signed in: the call fails as unauthenticated at once, nothing is sent', async () => {
    const { fetch, requests } = fakeFetch(() => json(200, clientProfile));
    const client = new OpenApiClient({ fetch, baseUrl: BASE_URL, accessToken$: of(null) });
    const failure = await firstValueFrom(client.me()).catch((e: unknown) => e);
    expect(failure).toMatchObject({ name: 'ApiError', code: 'unauthenticated', status: 401 });
    expect(requests).toHaveLength(0);
  });

  it('nothing is sent until accessToken$ has answered (a silent refresh comes first)', async () => {
    const { fetch, requests } = fakeFetch(() => json(200, clientProfile));
    const token$ = new Subject<string | null>();
    const client = new OpenApiClient({ fetch, baseUrl: BASE_URL, accessToken$: token$ });
    const pending = firstValueFrom(client.me());
    expect(requests).toHaveLength(0);
    token$.next('later');
    await pending;
    expect(requests[0]?.headers.get(AUTHORIZATION_HEADER)).toBe('Bearer later');
  });

  it('a problem+json answer becomes an ApiError with the catalogued code and status', async () => {
    const problem = {
      type: 'urn:fisio:error:client_exists',
      code: 'client_exists',
      title: 'Conflict',
      status: 409,
    };
    const { fetch } = fakeFetch(() => json(409, problem, PROBLEM_MEDIA_TYPE));
    const client = new OpenApiClient({ fetch, baseUrl: BASE_URL, accessToken$: of('tok') });

    const failure = await firstValueFrom(client.addClient(addClient)).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({ code: 'client_exists', status: 409, problem });
  });

  it('an answer that is not problem+json (an edge error page) is internal_error with its status', async () => {
    const { fetch } = fakeFetch(
      () =>
        new Response('<html>Bad gateway</html>', {
          status: 502,
          headers: { 'content-type': 'text/html' },
        }),
    );
    const client = new OpenApiClient({ fetch, baseUrl: BASE_URL, accessToken$: of('tok') });
    const failure = await firstValueFrom(client.me()).catch((e: unknown) => e);
    expect(failure).toMatchObject({ name: 'ApiError', code: 'internal_error', status: 502 });
  });

  it('a 200 whose body breaks the contract is rejected here, not deep in a view-model', async () => {
    const { fetch } = fakeFetch(() => json(200, { role: 'client', name: 'no id' }));
    const client = new OpenApiClient({ fetch, baseUrl: BASE_URL, accessToken$: of('tok') });
    await expect(firstValueFrom(client.me())).rejects.toThrow();
  });

  it('a request that never reaches the server surfaces as a NetworkError', async () => {
    const fetch: typeof globalThis.fetch = async () => {
      throw new TypeError('Failed to fetch');
    };
    const client = new OpenApiClient({ fetch, baseUrl: BASE_URL, accessToken$: of('tok') });
    const failure = await firstValueFrom(client.me()).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(NetworkError);
    expect((failure as NetworkError).cause).toBeInstanceOf(TypeError);
  });
});
