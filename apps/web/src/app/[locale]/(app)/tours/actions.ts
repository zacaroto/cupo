"use server";

// Tour, price and schedule actions (plan U5, R15, R16, R21, KTD9). Same rules
// as every server action: context and permission first, Zod on a plain
// object (ids as uuids), the operator id from `ctx` (inside the DAL), a
// found-check on every targeted write.
import {
  scheduleIdSchema,
  scheduleSchema,
  tourArchiveSchema,
  tourPriceSchema,
  tourSchema,
  tourUpdateSchema,
} from "@cupo/shared/schemas/tours";
import { refresh } from "next/cache";
import { redirect } from "@/i18n/navigation";
import { field, localeFrom } from "@/lib/auth/request";
import { requireOperatorContext } from "@/lib/dal/context";
import { NotFoundError } from "@/lib/dal/errors";
import {
  createSchedule,
  createTour,
  deleteSchedule,
  getTour,
  setTourArchived,
  setTourPrice,
  updateTour,
} from "@/lib/dal/tours";
import { errorState, validationState, withValues, type ActionState } from "@/lib/result";

export type TourActionState = ActionState;

const OK = { status: "ok" } as const;

function tourFields(formData: FormData) {
  return {
    name: field(formData, "name"),
    description: field(formData, "description"),
    durationMinutes: field(formData, "durationMinutes"),
    defaultCapacity: field(formData, "defaultCapacity"),
    meetingPoint: field(formData, "meetingPoint"),
  };
}

/** Creates a tour and opens it, where prices and schedules are added. */
export async function createTourAction(_previous: TourActionState, formData: FormData): Promise<TourActionState> {
  const locale = localeFrom(formData);
  const values = tourFields(formData);
  let tourId: string;
  try {
    const ctx = await requireOperatorContext("tours.write");
    const parsed = tourSchema.safeParse(values);
    if (!parsed.success) return withValues(validationState(parsed.error), values);
    tourId = await createTour(ctx, parsed.data);
  } catch (error) {
    return withValues(errorState(error), values);
  }
  return redirect({ href: `/tours/${tourId}`, locale });
}

export async function updateTourAction(_previous: TourActionState, formData: FormData): Promise<TourActionState> {
  const values = tourFields(formData);
  try {
    const ctx = await requireOperatorContext("tours.write");
    const parsed = tourUpdateSchema.safeParse({ tourId: field(formData, "tourId"), ...values });
    if (!parsed.success) return withValues(validationState(parsed.error), values);
    const { tourId, ...input } = parsed.data;
    await updateTour(ctx, tourId, input);
  } catch (error) {
    return withValues(errorState(error), values);
  }
  refresh();
  return OK;
}

/** R21: archive or restore. Archiving blocks new departures and reservations in the database. */
export async function setTourArchivedAction(_previous: TourActionState, formData: FormData): Promise<TourActionState> {
  try {
    const ctx = await requireOperatorContext("tours.write");
    const parsed = tourArchiveSchema.safeParse({ tourId: field(formData, "tourId"), archived: field(formData, "archived") });
    if (!parsed.success) return validationState(parsed.error);
    await setTourArchived(ctx, parsed.data.tourId, parsed.data.archived);
  } catch (error) {
    return errorState(error);
  }
  refresh();
  return OK;
}

/** Sets one channel price (KTD14): administradores only (`amounts.write`). */
export async function setTourPriceAction(_previous: TourActionState, formData: FormData): Promise<TourActionState> {
  const values = { amount: field(formData, "amount"), currency: field(formData, "currency") };
  try {
    const ctx = await requireOperatorContext("amounts.write");
    const parsed = tourPriceSchema.safeParse({ tourId: field(formData, "tourId"), channel: field(formData, "channel"), ...values });
    if (!parsed.success) return withValues(validationState(parsed.error), values);
    if (!(await getTour(ctx, parsed.data.tourId))) throw new NotFoundError("tour");
    await setTourPrice(ctx, parsed.data);
  } catch (error) {
    return withValues(errorState(error), values);
  }
  refresh();
  return OK;
}

function scheduleFields(formData: FormData) {
  return {
    weekday: field(formData, "weekday"),
    startTime: field(formData, "startTime"),
    capacityOverride: field(formData, "capacityOverride"),
    validFrom: field(formData, "validFrom"),
    validTo: field(formData, "validTo"),
  };
}

/** Adds a weekly schedule (R16). The same weekday and time twice is reported on the time field. */
export async function createScheduleAction(_previous: TourActionState, formData: FormData): Promise<TourActionState> {
  const values = scheduleFields(formData);
  try {
    const ctx = await requireOperatorContext("tours.write");
    const parsed = scheduleSchema.safeParse({ tourId: field(formData, "tourId"), ...values });
    if (!parsed.success) return withValues(validationState(parsed.error), values);
    if (!(await getTour(ctx, parsed.data.tourId))) throw new NotFoundError("tour");
    await createSchedule(ctx, parsed.data);
  } catch (error) {
    const state = errorState(error);
    if (state.error === "duplicate") {
      return withValues({ status: "error", error: "invalid", fieldErrors: { startTime: "validation.scheduleTaken" } }, values);
    }
    return withValues(state, values);
  }
  refresh();
  return OK;
}

export async function deleteScheduleAction(_previous: TourActionState, formData: FormData): Promise<TourActionState> {
  try {
    const ctx = await requireOperatorContext("tours.write");
    const parsed = scheduleIdSchema.safeParse({ scheduleId: field(formData, "scheduleId") });
    if (!parsed.success) return validationState(parsed.error);
    await deleteSchedule(ctx, parsed.data.scheduleId);
  } catch (error) {
    return errorState(error);
  }
  refresh();
  return OK;
}
