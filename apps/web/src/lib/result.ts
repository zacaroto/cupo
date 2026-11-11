// Maps every failure a server action can meet to a serializable action state
// (KTD5). This is the only module that knows SQLSTATE codes; business rules
// stay in the database triggers and are recognized here by name.
import { isTypedError, type ActionErrorCode } from "@cupo/shared/errors";
import type { ZodError } from "zod";
import { ForbiddenError, NotFoundError, UnauthenticatedError } from "./dal/errors";
import { logger } from "./logger";

export type ErrorState = {
  status: "error";
  error: ActionErrorCode;
  /** Field name to message key (Zod issues), for inline form errors. */
  fieldErrors?: Record<string, string>;
};

export type ActionState<T = undefined> =
  | { status: "idle" }
  | (T extends undefined ? { status: "ok"; data?: T } : { status: "ok"; data: T })
  | ErrorState;

export const idleState = { status: "idle" } as const;

export function okState<T>(data: T): { status: "ok"; data: T } {
  return { status: "ok", data };
}

/** Check constraints that carry a user-facing meaning; any other 23514 is `invalid`. */
const CHECK_CONSTRAINT_STATES: Readonly<Record<string, ActionErrorCode>> = {
  tour_departures_seats_within_capacity: "capacity_below_booked",
  operators_timezone_valid: "invalid_timezone",
};

/** SQLSTATE (and PostgREST code) to state, for codes without a per-message rule. */
const SQLSTATE_STATES: Readonly<Record<string, ActionErrorCode>> = {
  "42501": "forbidden", // insufficient privilege or row-level security violation
  "23505": "duplicate", // unique violation
  "23503": "invalid_reference", // foreign key violation (includes composite operator FKs)
  "23502": "invalid", // not null violation
  "22P02": "invalid", // invalid text representation (bad uuid, enum)
  "40P01": "retry", // deadlock detected
  "40001": "retry", // serialization failure
  PGRST116: "not_found", // .single() found no row
};

type DatabaseError = { code: string; message: string };

function isDatabaseError(value: unknown): value is DatabaseError {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { code?: unknown }).code === "string" &&
    typeof (value as { message?: unknown }).message === "string"
  );
}

function checkViolationState(message: string): ActionErrorCode {
  const constraint = /constraint "([a-z0-9_]+)"/.exec(message)?.[1];
  if (constraint && Object.prototype.hasOwnProperty.call(CHECK_CONSTRAINT_STATES, constraint)) {
    return CHECK_CONSTRAINT_STATES[constraint];
  }
  // operators_timezone_valid is raised by a trigger; PostgREST only forwards the message.
  if (message.startsWith("invalid timezone")) return "invalid_timezone";
  return "invalid";
}

function databaseErrorState(error: DatabaseError): ActionErrorCode | undefined {
  if (error.code === "P0001") {
    return isTypedError(error.message) ? error.message : undefined;
  }
  if (error.code === "23514") return checkViolationState(error.message);
  return Object.prototype.hasOwnProperty.call(SQLSTATE_STATES, error.code) ? SQLSTATE_STATES[error.code] : undefined;
}

/**
 * The action state for any thrown or returned failure. Unmapped failures
 * become `unexpected` and are logged by code only: database messages can
 * carry row contents (customer data), so they never reach the log.
 */
export function errorState(error: unknown): ErrorState {
  if (error instanceof UnauthenticatedError) return { status: "error", error: "unauthenticated" };
  if (error instanceof ForbiddenError) return { status: "error", error: "forbidden" };
  if (error instanceof NotFoundError) return { status: "error", error: "not_found" };

  if (isDatabaseError(error)) {
    const mapped = databaseErrorState(error);
    if (mapped) return { status: "error", error: mapped };
    logger.error("unmapped database error", { extra: { code: error.code } });
    return { status: "error", error: "unexpected" };
  }

  logger.error("unexpected action failure", {
    extra: { kind: error instanceof Error ? error.name : typeof error },
  });
  return { status: "error", error: "unexpected" };
}

/** An `invalid` state carrying the first message key per field. */
export function validationState(error: ZodError): ErrorState {
  const fieldErrors: Record<string, string> = {};
  for (const issue of error.issues) {
    const field = issue.path.map(String).join(".") || "_form";
    fieldErrors[field] ??= issue.message;
  }
  return { status: "error", error: "invalid", fieldErrors };
}
