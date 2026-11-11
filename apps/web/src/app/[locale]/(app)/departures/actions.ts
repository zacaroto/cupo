"use server";

// Departure actions (plan U5, R17, R18, KTD5, KTD9, KTD13). Context and
// permission first, Zod on a plain object, the operator id from `ctx`, a
// found-check on every targeted write. The state machine, the archived-tour
// rule and the capacity backstop are database rules; their errors arrive here
// by name and are mapped by result.ts.
import { departureCreateSchema, departureIdSchema, departureUpdateSchema } from "@cupo/shared/schemas/tours";
import { refresh } from "next/cache";
import { redirect } from "@/i18n/navigation";
import { field, localeFrom } from "@/lib/auth/request";
import { requireOperatorContext } from "@/lib/dal/context";
import { cancelDeparture, closeDeparture, createDeparture, getSeatsBooked, updateDeparture } from "@/lib/dal/departures";
import { errorState, validationState, withValues, type ActionState, type ErrorState } from "@/lib/result";

/** `seatsBooked` accompanies `capacity_below_booked`, so the form can say how many seats are sold. */
export type DepartureActionState = ActionState & { seatsBooked?: number };

const OK = { status: "ok" } as const;

/** A taken slot (the partial unique index, R17) is shown on the time field. */
function slotState(state: ErrorState, values: Record<string, string>): ErrorState {
  if (state.error !== "duplicate") return withValues(state, values);
  return withValues({ status: "error", error: "invalid", fieldErrors: { startTime: "validation.slotTaken" } }, values);
}

/** Creates an ad hoc departure (administradores and reservas; only administradores name a guide) and opens it. */
export async function createDepartureAction(
  _previous: DepartureActionState,
  formData: FormData,
): Promise<DepartureActionState> {
  const locale = localeFrom(formData);
  const values = {
    tourId: field(formData, "tourId"),
    date: field(formData, "date"),
    startTime: field(formData, "startTime"),
    capacity: field(formData, "capacity"),
    guideId: field(formData, "guideId"),
  };
  let departureId: string;
  try {
    const ctx = await requireOperatorContext("departures.ad_hoc");
    const parsed = departureCreateSchema.safeParse(values);
    if (!parsed.success) return withValues(validationState(parsed.error), values);
    departureId = await createDeparture(ctx, parsed.data);
  } catch (error) {
    return slotState(errorState(error), values);
  }
  return redirect({ href: `/departures/${departureId}`, locale });
}

/**
 * The administrador's edit: date, time, capacity and guide. Lowering capacity
 * below the sold seats answers `capacity_below_booked` with the current count.
 */
export async function updateDepartureAction(
  _previous: DepartureActionState,
  formData: FormData,
): Promise<DepartureActionState> {
  const values = {
    date: field(formData, "date"),
    startTime: field(formData, "startTime"),
    capacity: field(formData, "capacity"),
    guideId: field(formData, "guideId"),
  };
  try {
    const ctx = await requireOperatorContext("departures.write");
    const parsed = departureUpdateSchema.safeParse({ departureId: field(formData, "departureId"), ...values });
    if (!parsed.success) return withValues(validationState(parsed.error), values);
    try {
      await updateDeparture(ctx, parsed.data);
    } catch (error) {
      const state = errorState(error);
      if (state.error === "capacity_below_booked") {
        const seatsBooked = await getSeatsBooked(ctx, parsed.data.departureId);
        return { ...withValues(state, values), ...(seatsBooked !== null && { seatsBooked }) };
      }
      return slotState(state, values);
    }
  } catch (error) {
    return withValues(errorState(error), values);
  }
  refresh();
  return OK;
}

/** `scheduled -> closed` (R18). */
export async function closeDepartureAction(_previous: DepartureActionState, formData: FormData): Promise<DepartureActionState> {
  try {
    const ctx = await requireOperatorContext("departures.write");
    const parsed = departureIdSchema.safeParse({ departureId: field(formData, "departureId") });
    if (!parsed.success) return validationState(parsed.error);
    await closeDeparture(ctx, parsed.data.departureId);
  } catch (error) {
    return errorState(error);
  }
  refresh();
  return OK;
}

/** Cancels through `cancel_departure` (KTD5); from U6 this also cancels the active reservations. */
export async function cancelDepartureAction(_previous: DepartureActionState, formData: FormData): Promise<DepartureActionState> {
  try {
    const ctx = await requireOperatorContext("departures.write");
    const parsed = departureIdSchema.safeParse({ departureId: field(formData, "departureId") });
    if (!parsed.success) return validationState(parsed.error);
    await cancelDeparture(ctx, parsed.data.departureId);
  } catch (error) {
    return errorState(error);
  }
  refresh();
  return OK;
}
