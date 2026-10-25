import { describe, expect, it } from 'vitest';
import { MeResponseSchema, ProblemSchema } from '../src/api';
import { ERROR_CODES } from '../src/errors';

describe('API bodies shared by web and api (architecture §5.2)', () => {
  // Value: protects=the SPA can parse every problem the API can send, and nothing outside the catalogue; fails_when=the type URN and code can disagree in shape, or a code is missing from the schema; why_new=first problem schema; seam=none; no_claim=that the API sends matching type and code (API specs)
  it('Problem accepts every catalogued code as urn:fisio:error:<code>, and no other type', () => {
    for (const code of ERROR_CODES) {
      const problem = { type: `urn:fisio:error:${code}`, code, title: 't', status: 400 };
      expect(ProblemSchema.safeParse(problem).success, code).toBe(true);
    }
    const foreign = { type: 'about:blank', code: 'forbidden', title: 't', status: 403 };
    expect(ProblemSchema.safeParse(foreign).success).toBe(false);
  });

  // Value: protects=a /me body is one of the two role shapes, so the SPA can switch on role; fails_when=the union stops discriminating or the client profile loses a field; why_new=first /me schema; seam=none; no_claim=none
  it('Me is a client profile or a therapist profile, told apart by role', () => {
    const therapist = { role: 'therapist', therapistId: '7d9f3a52-5f53-4cb3-9c3b-6a3d0b1f2e4c' };
    expect(MeResponseSchema.parse(therapist)).toEqual(therapist);
    expect(MeResponseSchema.safeParse({ ...therapist, role: 'client' }).success).toBe(false);
  });
});
