#!/usr/bin/env node
// `pnpm openapi`, second step: docs/openapi.json → apps/web/src/services/api.generated.ts.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateApiTypes } from './src/index.mjs';

const OPENAPI_DOCUMENT = fileURLToPath(new URL('../../docs/openapi.json', import.meta.url));
const GENERATED_TYPES = fileURLToPath(
  new URL('../../apps/web/src/services/api.generated.ts', import.meta.url),
);

const document = JSON.parse(await readFile(OPENAPI_DOCUMENT, 'utf8'));
await mkdir(dirname(GENERATED_TYPES), { recursive: true });
await writeFile(GENERATED_TYPES, await generateApiTypes(document));
console.log(`wrote ${GENERATED_TYPES}`);
