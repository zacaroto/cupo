# Database test project

This directory holds the Vitest `db` project (`npm run test:db`): the
cross-operator isolation, role, capacity and audit suites that run against the
local Supabase stack. Files run in series (`--no-file-parallelism`).

- `setup.ts` maps `supabase status -o env` to the app variable names once per
  process (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`,
  `SUPABASE_SECRET_KEY`, plus `CUPO_TEST_DB_URL` for raw SQL), refuses any
  non-local URL and loads `.seed-users.json`.
- `fixtures.ts` holds the fixed operator, guide and tour ids (same as
  `supabase/seed.sql`) and the seed user specs; `scripts/seed-users.ts` reads
  them too.
- `helpers.ts`: `clientFor(user)`, `adminClient()`, `anonClient()`,
  `expectZeroRows`, `expectSqlState`, `expectTypedError`, `asRole()`,
  `createTestUser` / `deleteTestUser`, `sql()` and the `reconcileSeats()` stub
  (real from U6).
- `mailpit.ts` reads auth emails from the local mail UI (port 54324) so a test
  can follow an invite, magic-link or recovery link like a user.
- `auth.test.ts` covers the U3 scenarios by running the real server actions,
  the `/auth/confirm` route handler, the `@supabase/ssr` server client and the
  DAL, with only `next/headers` replaced by an in-memory cookie jar: password
  sign-in, magic-link and reset parity for unknown emails, the guía link, the
  invite and set-password gate, AE7, the operator switch and sign-out.
- `next-harness.ts` holds the cookie jar, form and redirect helpers and a
  fetch recorder (`withFetch`, which can also fake a mailer failure) for the
  suites that drive server actions (`auth.test.ts` keeps its inline copy).
- `members.test.ts` covers U4 members: new-email invite, AE9 (existing email
  from another operator: same state, no second user, one sign-in link, no
  minted link or token received or logged), duplicate invite, one
  `email_failed` state for every email failure with the membership undone,
  reservas forbidden (action and direct insert), resend, AE6 at the action
  layer, found-checks and the membership audit actor.
- `guides.test.ts` covers U4 guides: seeded guides and the guía context's
  `guideId`, `private.my_guide_ids()`, guides RLS and grants, contact email
  uniqueness, `guide_not_linked` / `guide_has_access`, and the create, edit,
  send-access (account created without an invite mail, magic link only, guía
  lands on the agenda) and deactivate actions.
- `tours.test.ts` covers U5 tours: the seeded catalog, AE2 for tours,
  prices, schedules and departures, AE4 for prices (reservas and guía get
  zero rows), the tour, price and schedule grants and constraints, and the
  create, edit, price, schedule and archive actions (found-checks, reservas
  and contabilidad forbidden).
- `departures.test.ts` covers U5 departures: column grants on server-owned
  columns, the slot's partial unique index, AE11 for the catalog, archived
  tours (`tour_archived`), the capacity backstop and its «Hay N lugares
  vendidos» action state, `starts_at` and the operator timezone recompute,
  `private.materialize_departure` (two concurrent calls, origin and capacity,
  slot reuse after a cancel, callers without a booking role), the state
  machine and `cancel_departure`, AE10 for the guía, the guide-deactivation
  clear (`guide_inactive`), and the departure actions and slot DAL.
- `foundation.test.ts` covers the U2 scenarios: AE2 cross-operator reads and
  writes, operator column grants, admin rpc privileges, AE6 last administrador,
  inactive operators, timezone validation, profiles visibility, password sign-in
  and `password_set_at`, audit actor sources, the auth user deletion cascade, the
  bootstrap script (idempotency and refusals), the seed guard and the pgTAP
  negative check.

Before running:

```bash
npx supabase start            # once
npx supabase db reset && npm run db:seed-users
npm run test:db
```

Tests that mutate data create throwaway users and operators and remove them in
`afterAll`, so the suite can run repeatedly against one reset. Seeded rows are
read-mostly; do not delete or demote seeded users in a test.
