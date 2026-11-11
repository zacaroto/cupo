// Zod 4 schemas for tours, prices, schedules and departures (plan U5, R15 to
// R18, KTD7, KTD9). They validate plain objects (the server action converts
// FormData first), turn form strings into column values and carry message
// keys: tour, price and schedule keys are translated under `tours`, departure
// keys under `departures`. The database checks mirror these limits, so a
// direct Data API write meets the same rules.
import { z } from "zod";
import { Constants, type Database } from "../database.types";
import { isIsoDate, normalizeLocalTime } from "../local-date";
import { isCurrencyCode, parseToMinor } from "../money";

export type Channel = Database["public"]["Enums"]["channel"];
export type DepartureStatus = Database["public"]["Enums"]["departure_status"];
export type DepartureOrigin = Database["public"]["Enums"]["departure_origin"];

export const CHANNELS: readonly Channel[] = Constants.public.Enums.channel;
export const DEPARTURE_STATUSES: readonly DepartureStatus[] = Constants.public.Enums.departure_status;

export const TOUR_NAME_MAX = 120;
export const TOUR_DESCRIPTION_MAX = 2000;
export const TOUR_MEETING_POINT_MAX = 300;
export const TOUR_DURATION_MAX_MINUTES = 43_200;
export const CAPACITY_MAX = 10_000;

const id = (key: string) => z.uuid({ error: key });

/** "" and whitespace become null; otherwise trimmed and bounded. */
function optionalText(max: number, key: string) {
  return z
    .string()
    .trim()
    .max(max, { error: key })
    .transform((value) => (value === "" ? null : value));
}

/** A whole number typed into a form, within [min, max]. */
function integerField(min: number, max: number, key: string) {
  return z
    .string({ error: key })
    .trim()
    .regex(/^\d{1,6}$/, { error: key })
    .transform(Number)
    .refine((value) => value >= min && value <= max, { error: key });
}

/** Like integerField, but "" is null (use the default). */
function optionalIntegerField(min: number, max: number, key: string) {
  return z
    .string()
    .trim()
    .refine((value) => value === "" || (/^\d{1,6}$/.test(value) && Number(value) >= min && Number(value) <= max), {
      error: key,
    })
    .transform((value) => (value === "" ? null : Number(value)));
}

const dateField = z
  .string({ error: "validation.dateInvalid" })
  .trim()
  .refine(isIsoDate, { error: "validation.dateInvalid" });

const optionalDateField = z
  .string()
  .trim()
  .refine((value) => value === "" || isIsoDate(value), { error: "validation.dateInvalid" })
  .transform((value) => (value === "" ? null : value));

/** `HH:MM` local wall-clock time, whole minutes. */
const timeField = z
  .string({ error: "validation.timeInvalid" })
  .transform((value, ctx) => {
    const time = normalizeLocalTime(value);
    if (time === null) {
      ctx.issues.push({ code: "custom", message: "validation.timeInvalid", input: value });
      return z.NEVER;
    }
    return time;
  });

const optionalGuideId = z
  .string()
  .trim()
  .refine((value) => value === "" || z.uuid().safeParse(value).success, { error: "validation.guideInvalid" })
  .transform((value) => (value === "" ? null : value));

// ---------------------------------------------------------------- tours

export const tourSchema = z.object({
  name: z
    .string({ error: "validation.nameRequired" })
    .trim()
    .min(1, { error: "validation.nameRequired" })
    .max(TOUR_NAME_MAX, { error: "validation.nameTooLong" }),
  description: optionalText(TOUR_DESCRIPTION_MAX, "validation.descriptionTooLong"),
  durationMinutes: integerField(1, TOUR_DURATION_MAX_MINUTES, "validation.durationInvalid"),
  defaultCapacity: integerField(1, CAPACITY_MAX, "validation.capacityInvalid"),
  meetingPoint: optionalText(TOUR_MEETING_POINT_MAX, "validation.meetingPointTooLong"),
});

export const tourIdSchema = z.object({ tourId: id("validation.idInvalid") });

export const tourUpdateSchema = tourIdSchema.extend(tourSchema.shape);

export const tourArchiveSchema = tourIdSchema.extend({
  archived: z.enum(["true", "false"], { error: "validation.idInvalid" }).transform((value) => value === "true"),
});

/** A channel price: the amount is typed in major units and stored in minor units of `currency`. */
export const tourPriceSchema = z
  .object({
    tourId: id("validation.idInvalid"),
    channel: z.enum(CHANNELS as [Channel, ...Channel[]], { error: "validation.channelInvalid" }),
    currency: z
      .string({ error: "validation.currencyInvalid" })
      .trim()
      .toUpperCase()
      .refine(isCurrencyCode, { error: "validation.currencyInvalid" }),
    amount: z.string({ error: "validation.priceInvalid" }),
  })
  .transform(({ amount, ...rest }, ctx) => {
    const priceMinor = parseToMinor(amount, rest.currency);
    if (priceMinor === null) {
      ctx.issues.push({ code: "custom", message: "validation.priceInvalid", path: ["amount"], input: amount });
      return z.NEVER;
    }
    return { ...rest, priceMinor };
  });

export const scheduleSchema = z
  .object({
    tourId: id("validation.idInvalid"),
    weekday: z
      .string({ error: "validation.weekdayInvalid" })
      .regex(/^[0-6]$/, { error: "validation.weekdayInvalid" })
      .transform(Number),
    startTime: timeField,
    capacityOverride: optionalIntegerField(1, CAPACITY_MAX, "validation.capacityInvalid"),
    validFrom: dateField,
    validTo: optionalDateField,
  })
  .refine((value) => value.validTo === null || value.validTo >= value.validFrom, {
    error: "validation.validToBeforeFrom",
    path: ["validTo"],
  });

export const scheduleIdSchema = z.object({ scheduleId: id("validation.idInvalid") });

// ---------------------------------------------------------------- departures

/** An ad hoc departure (R17). An empty capacity copies the tour default. */
export const departureCreateSchema = z.object({
  tourId: id("validation.tourRequired"),
  date: dateField,
  startTime: timeField,
  capacity: optionalIntegerField(1, CAPACITY_MAX, "validation.capacityInvalid"),
  guideId: optionalGuideId,
});

export const departureIdSchema = z.object({ departureId: id("validation.idInvalid") });

/** The administrador's edit (KTD13): date, time, capacity and guide. */
export const departureUpdateSchema = departureIdSchema.extend({
  date: dateField,
  startTime: timeField,
  capacity: integerField(1, CAPACITY_MAX, "validation.capacityInvalid"),
  guideId: optionalGuideId,
});

export type TourInput = z.infer<typeof tourSchema>;
export type TourPriceInput = z.infer<typeof tourPriceSchema>;
export type ScheduleInput = z.infer<typeof scheduleSchema>;
export type DepartureCreateInput = z.infer<typeof departureCreateSchema>;
export type DepartureUpdateInput = z.infer<typeof departureUpdateSchema>;
