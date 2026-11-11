// Error names shared by the database, the DAL and the UI (KTD5).
//
// Typed errors are raised by triggers and RPCs as
// `raise exception using errcode = 'P0001', message = '<name>'`; every name a
// migration raises is listed here once, and `apps/web/src/lib/result.ts` maps
// it to an action state with the same code. Each action error code has a
// message under `errors.<code>` in both message files (a unit test checks it).

/** Names raised with SQLSTATE P0001 by triggers and RPCs. Later units append theirs. */
export const TYPED_ERRORS = [
  "last_administrador",
  "guide_not_linked",
  "guide_has_access",
  "capacity_exceeded",
  "departure_not_open",
  "tour_archived",
  "forbidden_transition",
  "price_missing",
  "not_found",
  "guide_inactive",
] as const;

export type TypedErrorName = (typeof TYPED_ERRORS)[number];

/** States produced by the result mapper for non-typed failures. */
export const GENERIC_ERRORS = [
  "unauthenticated",
  "forbidden",
  "not_found",
  "invalid",
  "duplicate",
  "invalid_reference",
  "capacity_below_booked",
  "invalid_timezone",
  "retry",
  "unexpected",
] as const;

/** States specific to the sign-in, reset and set-password flows. */
export const AUTH_ERRORS = [
  "invalid_credentials",
  "weak_password",
  "same_password",
  "rate_limited",
  "link_invalid",
] as const;

/**
 * States specific to the members and guides flows (U4). `email_failed` is the
 * single state for every invite or sign-in email failure, whether the email
 * had an account or not (R9: responses never reveal it).
 */
export const ACCESS_ERRORS = ["email_failed", "guide_email_required"] as const;

export const ACTION_ERRORS = [...new Set([...GENERIC_ERRORS, ...TYPED_ERRORS, ...AUTH_ERRORS, ...ACCESS_ERRORS])] as const;

export type ActionErrorCode =
  | (typeof GENERIC_ERRORS)[number]
  | TypedErrorName
  | (typeof AUTH_ERRORS)[number]
  | (typeof ACCESS_ERRORS)[number];

export function isTypedError(value: unknown): value is TypedErrorName {
  return typeof value === "string" && (TYPED_ERRORS as readonly string[]).includes(value);
}

export function isActionErrorCode(value: unknown): value is ActionErrorCode {
  return typeof value === "string" && (ACTION_ERRORS as readonly string[]).includes(value);
}
