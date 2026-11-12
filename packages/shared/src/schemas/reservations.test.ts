import { describe, expect, it } from "vitest";
import {
  parseSlotValue,
  reservationCancelSchema,
  reservationCreateSchema,
  reservationFilterSchema,
  slotValue,
} from "./reservations";

const TOUR_ID = "7a100000-0000-4000-8000-00000000000a";
const DEPARTURE_ID = "1d000000-0000-4000-8000-000000000001";
const CUSTOMER_ID = "c0000000-0000-4000-8000-000000000001";

function issues(result: { success: boolean; error?: { issues: Array<{ path: PropertyKey[]; message: string }> } }) {
  return Object.fromEntries((result.error?.issues ?? []).map((issue) => [issue.path.join("."), issue.message]));
}

const base = {
  tourId: TOUR_ID,
  date: "2026-11-17",
  slot: `departure:${DEPARTURE_ID}`,
  people: "2",
  status: "confirmed",
  customerMode: "existing",
  customerId: CUSTOMER_ID,
  customerName: "",
  customerEmail: "",
  customerPhone: "",
  notes: "",
};

describe("slot values", () => {
  it("round-trips an existing departure and a schedule time", () => {
    expect(slotValue({ departureId: DEPARTURE_ID, startTime: "08:00" })).toBe(`departure:${DEPARTURE_ID}`);
    expect(slotValue({ departureId: null, startTime: "08:00" })).toBe("time:08:00");
    expect(parseSlotValue(`departure:${DEPARTURE_ID}`)).toEqual({ departureId: DEPARTURE_ID, startTime: null });
    expect(parseSlotValue("time:08:00:00")).toEqual({ departureId: null, startTime: "08:00" });
  });

  it("rejects anything else", () => {
    for (const value of ["", "departure:", "departure:nope", "time:25:00", "time:08:00:30", DEPARTURE_ID, "slot:08:00"]) {
      expect(parseSlotValue(value)).toBeNull();
    }
  });
});

describe("reservationCreateSchema", () => {
  it("books an existing departure for an existing customer", () => {
    expect(reservationCreateSchema.parse({ ...base, notes: "  Vegetariano  " })).toEqual({
      tourId: TOUR_ID,
      date: "2026-11-17",
      departureId: DEPARTURE_ID,
      startTime: null,
      people: 2,
      status: "confirmed",
      customer: { id: CUSTOMER_ID },
      notes: "Vegetariano",
    });
  });

  it("books a schedule slot for a new customer, lowercasing the email", () => {
    expect(
      reservationCreateSchema.parse({
        ...base,
        slot: "time:08:00",
        status: "pending_review",
        customerMode: "new",
        customerId: "",
        customerName: " Ana López ",
        customerEmail: "Ana@Example.com",
      }),
    ).toMatchObject({
      departureId: null,
      startTime: "08:00",
      status: "pending_review",
      customer: { name: "Ana López", email: "ana@example.com", phone: null },
      notes: null,
    });
  });

  it("refuses a cancelled status, zero people and a missing slot", () => {
    const result = reservationCreateSchema.safeParse({ ...base, status: "cancelled", people: "0", slot: "" });
    expect(issues(result)).toEqual({
      status: "validation.statusInvalid",
      people: "validation.peopleInvalid",
      slot: "validation.slotRequired",
    });
  });

  it("needs a picked customer in existing mode", () => {
    expect(issues(reservationCreateSchema.safeParse({ ...base, customerId: "" }))).toEqual({ customerId: "validation.customerRequired" });
  });

  it("reports new-customer errors on the form's customer fields with the customer keys", () => {
    const result = reservationCreateSchema.safeParse({ ...base, customerMode: "new", customerName: " ", customerEmail: "nope", customerPhone: "12" });
    expect(issues(result)).toEqual({
      customerName: "validation.nameRequired",
      customerEmail: "validation.emailInvalid",
      customerPhone: "validation.phoneInvalid",
    });
  });

  it("caps notes", () => {
    expect(issues(reservationCreateSchema.safeParse({ ...base, notes: "x".repeat(2001) }))).toEqual({ notes: "validation.notesTooLong" });
  });
});

describe("reservationCancelSchema", () => {
  it("requires a trimmed reason of at most 500 characters", () => {
    expect(reservationCancelSchema.parse({ reservationId: CUSTOMER_ID, reason: "  Cliente canceló " })).toEqual({
      reservationId: CUSTOMER_ID,
      reason: "Cliente canceló",
    });
    expect(issues(reservationCancelSchema.safeParse({ reservationId: CUSTOMER_ID, reason: "  " }))).toEqual({
      reason: "validation.reasonRequired",
    });
    expect(issues(reservationCancelSchema.safeParse({ reservationId: "x", reason: "y".repeat(501) }))).toEqual({
      reservationId: "validation.idInvalid",
      reason: "validation.reasonTooLong",
    });
  });
});

describe("reservationFilterSchema", () => {
  it("keeps valid dates and statuses and drops the rest", () => {
    expect(reservationFilterSchema.parse({ from: "2026-11-01", to: "2026-02-30", status: "cancelled" })).toEqual({
      from: "2026-11-01",
      to: null,
      status: "cancelled",
    });
    expect(reservationFilterSchema.parse({ status: "nope" })).toEqual({ from: null, to: null, status: null });
  });
});
