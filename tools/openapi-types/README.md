# @fisio/openapi-types

The second step of `pnpm openapi`: `docs/openapi.json` → `apps/web/src/services/api.generated.ts`,
the `paths` types the SPA's `ApiClient` (`openapi-fetch`) is typed with.

A package of its own because `openapi-typescript` prints its output through the TypeScript 5
compiler API (`ts.factory`), which the TypeScript 7 compiler the repository type-checks with does
not provide. Only this package depends on TypeScript 5; nothing here is shipped.

- `generateApiTypes(document)` (`src/index.mjs`): the generator, also called by the staleness
  spec `apps/web/src/services/api.generated.spec.ts`, which fails while the committed file is out
  of date.
- `generate.mjs`: the CLI `pnpm openapi` runs after the API has rewritten `docs/openapi.json`.
