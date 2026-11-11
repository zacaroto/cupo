// Fixed identities shared by supabase/seed.sql, scripts/seed-users.ts and the
// db suite. Keep the operator uuids identical to the ones in seed.sql (a test
// asserts they match).

export type OperatorKey = "a" | "b" | "c";

export const OPERATORS = {
  a: {
    id: "0a000000-0000-4000-8000-00000000000a",
    name: "Operator A",
    slug: "operator-a",
    timezone: "America/Costa_Rica",
    currency: "USD",
    locale: "es",
  },
  b: {
    id: "0b000000-0000-4000-8000-00000000000b",
    name: "Operator B",
    slug: "operator-b",
    timezone: "America/Mexico_City",
    currency: "MXN",
    locale: "es",
  },
  c: {
    id: "0c000000-0000-4000-8000-00000000000c",
    name: "Operator C",
    slug: "operator-c",
    timezone: "Europe/Madrid",
    currency: "EUR",
    locale: "en",
  },
} as const satisfies Record<OperatorKey, Record<string, string>>;

export type MembershipRole = "administrador" | "reservas" | "contabilidad" | "guia";

export type GuideKey = "a1" | "a2" | "b1";

/** Guides seeded by supabase/seed.sql (keep the uuids in sync). a1 is linked to the seeded guía. */
export const GUIDES = {
  a1: { id: "9a100000-0000-4000-8000-00000000000a", operator: "a", name: "Guía A", email: "guia-a@cupo.test" },
  a2: { id: "9a200000-0000-4000-8000-00000000000a", operator: "a", name: "Guía A sin cuenta", email: "guia-a2@cupo.test" },
  b1: { id: "9b100000-0000-4000-8000-00000000000b", operator: "b", name: "Guía B", email: "guia-b@cupo.test" },
} as const satisfies Record<GuideKey, { id: string; operator: OperatorKey; name: string; email: string }>;

export type SeedUserSpec = {
  email: string;
  fullName: string;
  /** Staff users get `app_metadata.password_set_at`; the guía does not (KTD8). */
  staff: boolean;
  memberships: ReadonlyArray<{ operator: OperatorKey; role: MembershipRole }>;
  /** Seeded guide to link before the memberships (a guía membership requires it, R19). */
  guide?: GuideKey;
};

/** Every role of A, one user in A and B, one user in B (plan U2 step 4). */
export const SEED_USERS = {
  adminA: {
    email: "admin-a@cupo.test",
    fullName: "Admin A",
    staff: true,
    memberships: [{ operator: "a", role: "administrador" }],
  },
  reservasA: {
    email: "reservas-a@cupo.test",
    fullName: "Reservas A",
    staff: true,
    memberships: [{ operator: "a", role: "reservas" }],
  },
  contabilidadA: {
    email: "contabilidad-a@cupo.test",
    fullName: "Contabilidad A",
    staff: true,
    memberships: [{ operator: "a", role: "contabilidad" }],
  },
  guiaA: {
    email: "guia-a@cupo.test",
    fullName: "Guía A",
    staff: false,
    memberships: [{ operator: "a", role: "guia" }],
    guide: "a1",
  },
  adminAB: {
    email: "admin-ab@cupo.test",
    fullName: "Admin AB",
    staff: true,
    memberships: [
      { operator: "a", role: "administrador" },
      { operator: "b", role: "administrador" },
    ],
  },
  reservasB: {
    email: "reservas-b@cupo.test",
    fullName: "Reservas B",
    staff: true,
    memberships: [{ operator: "b", role: "reservas" }],
  },
} as const satisfies Record<string, SeedUserSpec>;

export type SeedUserKey = keyof typeof SEED_USERS;

/** Shape of tests/db/.seed-users.json written by scripts/seed-users.ts. */
export type SeedUsersFile = {
  createdAt: string;
  url: string;
  users: Record<SeedUserKey, { id: string; email: string; password: string }>;
};

export const SEED_USERS_FILE = "tests/db/.seed-users.json";
