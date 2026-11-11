# Database test project

This directory holds the Vitest `db` project (`npm run test:db`): the
cross-operator isolation, role, capacity and audit suites that run against the
local Supabase stack.

U1 only reserves the directory. U2 fills `setup.ts` (environment mapping from
`supabase status -o env`), `helpers.ts` and the first `*.test.ts` files.
