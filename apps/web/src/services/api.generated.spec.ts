import { generateApiTypes } from '@fisio/openapi-types';
import { describe, expect, it } from 'vitest';
import document from '../../../../docs/openapi.json';
import generated from './api.generated?raw';

describe('Generated API types (architecture §7.3: openapi-typescript from docs/openapi.json)', () => {
  it('are up to date with docs/openapi.json (otherwise run pnpm openapi)', async () => {
    expect(generated).toBe(await generateApiTypes(document));
  });
});
