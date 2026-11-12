import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ForbiddenError, NotFoundError, UnauthenticatedError } from "./dal/errors";
import { errorState, okState, validationState } from "./result";

/** Shape of a PostgREST error as returned by supabase-js. */
function pgError(code: string, message: string, details: string | null = null) {
  return { code, message, details, hint: null, name: "PostgrestError" };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("result mapper (KTD5)", () => {
  it("maps the DAL error classes", () => {
    expect(errorState(new UnauthenticatedError())).toEqual({ status: "error", error: "unauthenticated" });
    expect(errorState(new ForbiddenError("reservations.write"))).toEqual({ status: "error", error: "forbidden" });
    expect(errorState(new NotFoundError("reservation"))).toEqual({ status: "error", error: "not_found" });
  });

  it("maps a P0001 typed error by its message", () => {
    expect(errorState(pgError("P0001", "capacity_exceeded"))).toEqual({ status: "error", error: "capacity_exceeded" });
    expect(errorState(pgError("P0001", "last_administrador"))).toEqual({ status: "error", error: "last_administrador" });
  });

  it("treats an unknown P0001 message as unexpected", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(errorState(pgError("P0001", "something_new"))).toEqual({ status: "error", error: "unexpected" });
  });

  it("maps 23514 naming the seats constraint to the capacity-below-booked state", () => {
    const error = pgError(
      "23514",
      'new row for relation "tour_departures" violates check constraint "tour_departures_seats_within_capacity"',
      "Failing row contains (...)",
    );
    expect(errorState(error)).toEqual({ status: "error", error: "capacity_below_booked" });
  });

  it("maps the operator timezone check and other check violations", () => {
    expect(errorState(pgError("23514", 'invalid timezone "America/Nowhere"'))).toEqual({
      status: "error",
      error: "invalid_timezone",
    });
    expect(
      errorState(pgError("23514", 'new row for relation "operators" violates check constraint "operators_currency_format"')),
    ).toEqual({ status: "error", error: "invalid" });
  });

  it("maps a reservation check and an rpc's invalid parameter to invalid (U6)", () => {
    expect(
      errorState(
        pgError("23514", 'new row for relation "reservations" violates check constraint "reservations_cancel_reason_required"'),
      ),
    ).toEqual({ status: "error", error: "invalid" });
    expect(errorState(pgError("22023", "a customer id or a customer name is required"))).toEqual({ status: "error", error: "invalid" });
  });

  it("maps the reservation typed errors by name (U6)", () => {
    for (const name of ["capacity_exceeded", "departure_not_open", "tour_archived", "forbidden_transition", "price_missing"]) {
      expect(errorState(pgError("P0001", name))).toEqual({ status: "error", error: name });
    }
  });

  it("maps 40P01 (deadlock) to a retry state", () => {
    expect(errorState(pgError("40P01", "deadlock detected"))).toEqual({ status: "error", error: "retry" });
  });

  it("maps privilege, uniqueness and foreign-key failures", () => {
    expect(errorState(pgError("42501", 'new row violates row-level security policy for table "memberships"'))).toEqual({
      status: "error",
      error: "forbidden",
    });
    expect(errorState(pgError("23505", "duplicate key value violates unique constraint"))).toEqual({
      status: "error",
      error: "duplicate",
    });
    expect(errorState(pgError("23503", "insert or update violates foreign key constraint"))).toEqual({
      status: "error",
      error: "invalid_reference",
    });
  });

  it("maps PostgREST no-row errors to not_found", () => {
    expect(errorState(pgError("PGRST116", "JSON object requested, multiple (or no) rows returned"))).toEqual({
      status: "error",
      error: "not_found",
    });
  });

  it("logs unmapped failures by code only, never the database message", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const state = errorState(pgError("XX000", 'Failing row contains (person@example.com)'));
    expect(state).toEqual({ status: "error", error: "unexpected" });
    const line = String(spy.mock.calls.at(-1)?.[0]);
    expect(line).toContain("XX000");
    expect(line).not.toContain("person@example.com");
  });

  it("maps arbitrary thrown values to unexpected", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(errorState(new Error("boom"))).toEqual({ status: "error", error: "unexpected" });
    expect(errorState("nope")).toEqual({ status: "error", error: "unexpected" });
    expect(errorState(null)).toEqual({ status: "error", error: "unexpected" });
  });

  it("builds ok and validation states", () => {
    expect(okState({ code: "A-0001" })).toEqual({ status: "ok", data: { code: "A-0001" } });
    const parsed = z.object({ email: z.email({ error: "validation.emailInvalid" }) }).safeParse({ email: "x" });
    if (parsed.success) throw new Error("expected a failure");
    expect(validationState(parsed.error)).toEqual({
      status: "error",
      error: "invalid",
      fieldErrors: { email: "validation.emailInvalid" },
    });
  });
});
