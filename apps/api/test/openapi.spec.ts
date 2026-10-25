import { readFileSync } from 'node:fs';
import { closeTestDocumentClient } from '@fisio/testkit';
import { afterAll, describe, expect, it } from 'vitest';
import { openApiDocument } from '../src/http/app';
import { OPENAPI_FILE, renderOpenApiJson } from '../src/openapi';
import { apiHarness } from './harness';
import { registerSpecRoutes } from './spec-routes';

afterAll(closeTestDocumentClient);

describe('OpenAPI document (architecture §5.2)', () => {
  // Value: protects=docs/openapi.json, from which the SPA client is generated, matches the routes; fails_when=a route or schema changes without `pnpm openapi`; why_new=first generated document; seam=none; no_claim=that the SPA regenerated its types
  it('docs/openapi.json is current: `pnpm openapi` would not change it', () => {
    expect(readFileSync(OPENAPI_FILE, 'utf8')).toBe(renderOpenApiJson());
  });

  // Value: protects=the document lists exactly the deployed routes with their access level, and no /__dev route; fails_when=a route is missing, a dev route leaks into the document, or x-access/security are dropped; why_new=first document; seam=none; no_claim=route behaviour
  it('lists the deployed routes with x-access and bearer security, and no /__dev route', () => {
    const doc = JSON.parse(renderOpenApiJson());
    expect(Object.keys(doc.paths).sort()).toEqual(['/health', '/me']);
    expect(doc.paths['/health'].get['x-access']).toBe('public');
    expect(doc.paths['/health'].get.security).toBeUndefined();
    expect(doc.paths['/me'].get['x-access']).toBe('member');
    expect(doc.paths['/me'].get.security).toEqual([{ bearerAuth: [] }]);
    expect(Object.keys(doc.paths['/me'].get.responses).sort()).toEqual([
      '200',
      '401',
      '403',
      '500',
    ]);
    expect(doc.paths['/me'].get.responses['401'].content).toHaveProperty([
      'application/problem+json',
    ]);
  });

  // Value: protects=each route documents exactly the problem statuses its access level and request validation can give, and the bearer scheme its security names exists, so the SPA's generated client types every error it can receive; fails_when=defineRoute drops validation_failed for validated routes, adds 401/403 to public routes, or the bearerAuth component is no longer registered; why_new=the deployed routes have no validated body and the committed document is regenerated, not reviewed; seam=spec routes (validated member route, public route); no_claim=the codes a handler raises itself (added per route)
  it('documents the problem statuses of each access level and validation, and the bearer scheme', () => {
    const { api } = apiHarness({ extend: registerSpecRoutes });
    const doc = openApiDocument(api);
    const statuses = (path: string, method: 'get' | 'post') =>
      Object.keys(doc.paths?.[path]?.[method]?.responses ?? {}).sort();
    expect(statuses('/health', 'get')).toEqual(['200', '500']);
    expect(statuses('/spec/therapist-only', 'get')).toEqual(['200', '401', '403', '500']);
    expect(statuses('/spec/validated/{slotId}', 'post')).toEqual([
      '200',
      '400',
      '401',
      '403',
      '500',
    ]);
    const badRequest = doc.paths?.['/spec/validated/{slotId}']?.post?.responses?.['400'] as {
      description: string;
      content: Record<string, unknown>;
    };
    expect(badRequest.description).toContain('`validation_failed`');
    expect(badRequest.content).toHaveProperty(['application/problem+json']);
    expect(doc.components?.securitySchemes?.bearerAuth).toMatchObject({
      type: 'http',
      scheme: 'bearer',
    });
  });

  // Value: protects=refined formats keep their shape in the contract, so the SPA's types and docs show a pattern, not a bare string; fails_when=the regex next to a refine is dropped, or a transform/refine breaks generation; why_new=TODOS.md (OpenAPI patterns for refine-only schemas); seam=spec route that uses all three; no_claim=that the pattern is the whole check (the refine adds real-date and DST checks)
  it('SlotId, IsoDate and LocalTime carry a pattern and an example', () => {
    const { api } = apiHarness({ extend: registerSpecRoutes });
    const schemas = openApiDocument(api).components?.schemas ?? {};
    for (const [name, example] of [
      ['SlotId', '2027-03-28T09:00#pool'],
      ['IsoDate', '2027-03-28'],
      ['LocalTime', '09:00'],
    ] as const) {
      const schema = schemas[name] as { pattern?: string; example?: string };
      expect(schema.pattern, name).toBeTypeOf('string');
      expect(new RegExp(schema.pattern ?? '$^').test(example), name).toBe(true);
      expect(schema.example, name).toBe(example);
    }
    expect(
      new RegExp((schemas.SlotId as { pattern: string }).pattern).test('2027-03-28T09:00#gym'),
    ).toBe(false);
  });

  // Value: protects=the SPA's generated types and docs know a client email is an email; fails_when=the piped EmailSchema loses its format in the generated document; why_new=the pattern spec above covers ids and dates only; seam=none; no_claim=the server-side validation itself (contracts specs)
  it('a client email carries format email and an example', () => {
    const { api } = apiHarness();
    const schemas = openApiDocument(api).components?.schemas ?? {};
    const profile = schemas.ClientProfile as { properties: Record<string, unknown> };
    expect(profile.properties.email).toMatchObject({
      type: 'string',
      format: 'email',
      example: 'cliente@example.com',
    });
  });
});
