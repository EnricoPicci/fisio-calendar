// Local stack: docker-compose (DynamoDB Local, Mailpit), auth emulator, tick runner, seed.
// Nothing is exported from the package root: consumers import the subpath exports declared in
// package.json (`@fisio/local/table`); later work packages add theirs (docs/implementation-plan.md).
export {};
