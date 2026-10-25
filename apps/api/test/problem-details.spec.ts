import { errorCodeFromProblemType, PROBLEM_MEDIA_TYPE } from '@fisio/contracts';
import { closeTestDocumentClient } from '@fisio/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiHarness, type CallResult } from './harness';
import { registerSpecRoutes } from './spec-routes';

const h = apiHarness({ extend: registerSpecRoutes });
afterAll(closeTestDocumentClient);

let token: string;
beforeAll(async () => {
  token = (await h.seedTherapist()).token;
});

function expectProblem(res: CallResult, code: string, status: number) {
  expect(res.status).toBe(status);
  expect(res.contentType).toBe(PROBLEM_MEDIA_TYPE);
  expect(res.body).toMatchObject({ type: `urn:fisio:error:${code}`, code, status });
  expect(errorCodeFromProblemType(res.body.type)).toBe(code);
}

const validPath = '/spec/validated/2027-03-28T09%3A00%23pool?from=2027-03-28';
const validBody = { start: '09:00', places: 1 };

describe('all: every problem+json carries a catalogued ErrorCode (architecture §5.2)', () => {
  // Value: protects=an unknown path answers JSON the SPA understands, not Hono's text 404; fails_when=notFound is not installed on the root app or the API router; why_new=first error handler; seam=none; no_claim=CloudFront's behaviour for /api/* (smoke, WP0.10)
  it('an unknown path or method → 404 not_found', async () => {
    expectProblem(await h.call('GET', '/nope'), 'not_found', 404);
    expectProblem(await h.call('DELETE', '/health'), 'not_found', 404);
  });

  // Value: protects=an unexpected error becomes internal_error without leaking its text, and is logged; fails_when=onError forwards error.message or a stack, or swallows the log; why_new=first error handler; seam=a spec route that throws; no_claim=log format (Powertools, WP0.9)
  it('an unexpected error → 500 internal_error, logged, with nothing of the error in the body', async () => {
    const logged = h.loggedErrors.length;
    const res = await h.call('GET', '/spec/throw/unexpected');
    expectProblem(res, 'internal_error', 500);
    expect(JSON.stringify(res.body)).not.toMatch(/secret|fisio-prod|T#123|stack/);
    expect(h.loggedErrors).toHaveLength(logged + 1);
  });
});

describe('all: Zod rejection → 400 validation_failed with paths (architecture §5.2, §9.2)', () => {
  // Value: protects=the valid request reaches the handler, so the rejections below are about the input; fails_when=the route or schemas themselves are broken; why_new=baseline for the spec route; seam=spec route; no_claim=none
  it('accepts a request that satisfies every schema', async () => {
    const res = await h.call('POST', validPath, { token, json: validBody });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ slotId: '2027-03-28T09:00#pool' });
  });

  // Value: protects=a rejected body lists where and why, by Zod code, never by sentence; fails_when=the hook returns Hono's default 400 shape, or messages replace codes; why_new=first validation hook; seam=spec route; no_claim=which Zod code each rule yields beyond those asserted
  it('lists each rejected body field with its path and code; unknown fields are rejected', async () => {
    const res = await h.call('POST', validPath, {
      token,
      json: { start: '25:00', places: 0, extra: true },
    });
    expectProblem(res, 'validation_failed', 400);
    expect(res.body.errors).toEqual(
      expect.arrayContaining([
        { in: 'body', path: ['start'], code: expect.any(String) },
        { in: 'body', path: ['places'], code: 'too_small' },
        { in: 'body', path: [], code: 'unrecognized_keys' },
      ]),
    );
  });

  // Value: protects=query and path params are validated too, with their location; fails_when=only the body is mapped, or the location is wrong; why_new=first validation hook; seam=spec route; no_claim=the order of checks between parts
  it('reports the query and the path parameter with their location', async () => {
    const query = await h.call(
      'POST',
      '/spec/validated/2027-03-28T09%3A00%23pool?from=2027-02-30',
      {
        token,
        json: validBody,
      },
    );
    expectProblem(query, 'validation_failed', 400);
    expect(query.body.errors).toEqual([{ in: 'query', path: ['from'], code: 'custom' }]);

    const gap = await h.call('POST', '/spec/validated/2027-03-28T02%3A30%23pool?from=2027-03-28', {
      token,
      json: validBody,
    });
    expectProblem(gap, 'validation_failed', 400);
    expect(gap.body.errors).toEqual([{ in: 'path', path: ['slotId'], code: 'custom' }]);
  });

  // Value: protects=a body that is not JSON is a client error, not a 500; fails_when=Hono's HTTPException(400) is mapped to internal_error; why_new=first error mapper; seam=none; no_claim=other content types
  it('a body that is not valid JSON → 400 validation_failed', async () => {
    const logged = h.loggedErrors.length;
    const res = await h.call('POST', validPath, {
      token,
      headers: { 'content-type': 'application/json' },
      rawBody: '{"start": "09:00",',
    });
    expectProblem(res, 'validation_failed', 400);
    expect(h.loggedErrors).toHaveLength(logged);
  });

  // Value: protects=only Hono's unparsable-body 400 is read as the caller's mistake; any other Hono refusal is a logged server fault; fails_when=toApiError maps every HTTPException to validation_failed (a 413 or 401 from a framework middleware becomes a silent 400) or passes Hono's status and message through uncatalogued; why_new=the invalid-JSON spec covers only status 400; seam=spec route that throws HTTPException(413); no_claim=which framework middlewares the API will mount
  it('a Hono refusal other than an unparsable body → 500 internal_error, logged', async () => {
    const logged = h.loggedErrors.length;
    const res = await h.call('GET', '/spec/throw/http-413');
    expectProblem(res, 'internal_error', 500);
    expect(h.loggedErrors).toHaveLength(logged + 1);
  });

  // Value: protects=authentication runs before validation, so a stranger learns nothing about the schema; fails_when=the validators run before the authorize middleware; why_new=first route with both; seam=spec route; no_claim=none
  it('a request without a token is 401 even when its body is invalid', async () => {
    expectProblem(await h.call('POST', validPath, { json: {} }), 'unauthenticated', 401);
  });
});

describe('API error mapper: domain time errors → validation_failed (TODOS.md, architecture §5.5)', () => {
  // Value: protects=a DST-gap time, a malformed slot id or a non-existent date reaching the domain answers 400, not 500; fails_when=the mapper drops a name or only uses instanceof; why_new=the mapper did not exist before WP0.4; seam=spec routes that call the domain; no_claim=the offending path (the use case's job)
  it('maps NonexistentLocalTimeError, InvalidSlotIdError and InvalidLocalValueError to 400', async () => {
    for (const path of ['dst-gap', 'bad-slot-id', 'bad-local-date']) {
      expectProblem(await h.call('GET', `/spec/throw/${path}`), 'validation_failed', 400);
    }
  });

  // Value: protects=a domain error from a second copy of @fisio/domain in the bundle still maps; fails_when=the mapper uses instanceof only; why_new=TODOS.md item; seam=an error with the domain name and another class; no_claim=bundling (WP0.9)
  it('recognises the errors by name, so a second copy of the domain module still maps', async () => {
    expectProblem(
      await h.call('GET', '/spec/throw/foreign-domain-error'),
      'validation_failed',
      400,
    );
  });

  // Value: protects=a runtime without tz data shows as a server fault, not as the caller's mistake; fails_when=InvalidTimeZoneError is mapped to validation_failed; why_new=decision recorded in TODOS.md; seam=spec route; no_claim=zones from requests (none in v1)
  it('maps InvalidTimeZoneError to 500 internal_error: no request carries a zone in v1', async () => {
    expectProblem(await h.call('GET', '/spec/throw/time-zone'), 'internal_error', 500);
  });
});

describe('Role guards (architecture §8.2)', () => {
  // Value: protects=a client cannot call a therapist route even with a valid token; fails_when=the therapist guard checks only authentication; why_new=no /admin route exists yet; seam=spec route; no_claim=ownership checks inside use cases
  it('wrong role → 403 forbidden', async () => {
    const client = await h.seedClient('enabled');
    expectProblem(
      await h.call('GET', '/spec/therapist-only', { token: client.token }),
      'forbidden',
      403,
    );
    expect((await h.call('GET', '/spec/therapist-only', { token })).status).toBe(200);
  });
});
