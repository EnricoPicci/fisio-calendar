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
});
