import {
  ERROR_CATALOGUE,
  type ErrorCode,
  httpStatusOf,
  PROBLEM_MEDIA_TYPE,
  ProblemSchema,
} from '@fisio/contracts';

/**
 * OpenAPI response entries for problem+json errors: one per HTTP status, listing every
 * catalogued code that status can carry, so the generated document names the codes a client
 * must handle.
 */
export function problemResponses(codes: readonly ErrorCode[]) {
  const byStatus = new Map<number, ErrorCode[]>();
  for (const code of new Set(codes)) {
    const status = httpStatusOf(code);
    byStatus.set(status, [...(byStatus.get(status) ?? []), code]);
  }
  return Object.fromEntries(
    [...byStatus].map(([status, list]) => [
      status,
      {
        description: list.map((code) => `\`${code}\`: ${ERROR_CATALOGUE[code].meaning}`).join('; '),
        ...(status === 401 ? { headers: { 'WWW-Authenticate': BEARER_CHALLENGE } } : {}),
        content: { [PROBLEM_MEDIA_TYPE]: { schema: ProblemSchema } },
      },
    ]),
  );
}

/** The challenge every 401 carries (`problemResponse` in ./problem.ts). */
const BEARER_CHALLENGE = {
  description:
    '`Bearer` when no token was sent; `Bearer error="invalid_token"` when one was sent and refused (RFC 6750 §3)',
  schema: { type: 'string' as const, enum: ['Bearer', 'Bearer error="invalid_token"'] },
};
