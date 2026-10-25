import type { Problem } from '@fisio/contracts';
import { SlotId } from '@fisio/domain';
import { closeTestDocumentClient, inProcessFetch } from '@fisio/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API_BASE_PATH } from '../src/http/app';
import { apiHarness } from './harness';
import { registerSpecRoutes } from './spec-routes';

const h = apiHarness({ extend: registerSpecRoutes });
afterAll(closeTestDocumentClient);

let token: string;
beforeAll(async () => {
  token = (await h.seedTherapist()).token;
});

const fetch = inProcessFetch(h.app);
const post = (path: string) =>
  fetch(`${API_BASE_PATH}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ start: '09:00', places: 1 }),
  });

describe('Slot ids in URL paths (TODOS.md, architecture §5.2)', () => {
  const id = SlotId.of('2027-03-28T09:00#pool');

  // Value: protects=a slot id survives a path param through the fetch adapter and Hono's decoding; fails_when=toPathSegment stops encoding `#`, or Hono stops decoding params; why_new=TODOS.md item, before /admin/slots/{slotId}/cancel exists; seam=spec route with a SlotId param; no_claim=CloudFront and the Function URL keep %23 (dev smoke, WP0.10)
  it('an id written with SlotId.toPathSegment reaches the route as the same id', async () => {
    expect(SlotId.toPathSegment(id)).toBe('2027-03-28T09%3A00%23pool');
    const res = await post(`/spec/validated/${SlotId.toPathSegment(id)}?from=2027-03-28`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ slotId: id });
  });

  // Value: protects=documents why the encoding is required: an unencoded `#` starts the fragment, so the route sees a cut id and no query; fails_when=never, unless URL parsing changes; why_new=TODOS.md failure mode; seam=none; no_claim=none
  it('an unencoded id loses everything after `#`, so the route receives another id', async () => {
    const res = await post(`/spec/validated/${id}?from=2027-03-28`);
    expect(res.status).toBe(400);
    // The query went into the fragment too; validation stops at the first failing part.
    expect(((await res.json()) as Problem).errors).toEqual([
      { in: 'query', path: ['from'], code: 'invalid_type' },
    ]);
  });
});
