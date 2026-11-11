// Role permission map (KTD4). One pure table used by the server DAL (the
// authority, together with RLS) and by the UI (navigation, hidden controls).
// Hiding a control is never access control: every server action calls
// `requireOperatorContext(action)`, and the database enforces the same rules.
import { Constants, type Database } from "./database.types";

/** The four membership roles, derived from the generated `membership_role` enum. */
export type Role = Database["public"]["Enums"]["membership_role"];

export const ROLES: readonly Role[] = Constants.public.Enums.membership_role;

/** Roles that sign in with a password and must set one before using the app (KTD8). */
export const STAFF_ROLES = ["administrador", "reservas", "contabilidad"] as const satisfies readonly Role[];

export type StaffRole = (typeof STAFF_ROLES)[number];

/**
 * Every permission the app checks. `<area>.read` gates pages and navigation;
 * the other verbs gate server actions.
 */
export const ACTIONS = [
  "members.read",
  "members.invite",
  "members.write",
  "guides.read",
  "guides.write",
  "tours.read",
  "tours.write",
  "departures.read",
  "departures.write",
  "departures.ad_hoc",
  "reservations.read",
  "reservations.write",
  "notes.read",
  "amounts.read",
  "amounts.write",
  "customers.read",
  "customers.read_full",
  "customers.write",
  "audit.read",
  "agenda.read",
] as const;

export type Action = (typeof ACTIONS)[number];

/**
 * R11 in one place: amounts (and tour prices) for administrador and
 * contabilidad; full customer data for administrador and reservas; notes for
 * every staff role; guía sees only their agenda.
 */
export const PERMISSIONS: Readonly<Record<Role, readonly Action[]>> = {
  administrador: ACTIONS,
  reservas: [
    "guides.read",
    "tours.read",
    "departures.read",
    "departures.ad_hoc",
    "reservations.read",
    "reservations.write",
    "notes.read",
    "customers.read",
    "customers.read_full",
    "customers.write",
  ],
  contabilidad: [
    "guides.read",
    "tours.read",
    "departures.read",
    "reservations.read",
    "notes.read",
    "amounts.read",
    "customers.read",
  ],
  guia: ["agenda.read"],
};

/** True when `role` may perform `action`. Unknown roles or actions are denied. */
export function can(role: Role, action: Action): boolean {
  const granted = Object.prototype.hasOwnProperty.call(PERMISSIONS, role) ? PERMISSIONS[role] : undefined;
  return granted?.includes(action) ?? false;
}

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

export function isStaffRole(role: Role): role is StaffRole {
  return (STAFF_ROLES as readonly Role[]).includes(role);
}
