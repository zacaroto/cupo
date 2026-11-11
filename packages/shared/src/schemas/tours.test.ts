import { describe, expect, it } from "vitest";
import {
  departureCreateSchema,
  departureUpdateSchema,
  scheduleSchema,
  tourArchiveSchema,
  tourPriceSchema,
  tourSchema,
} from "./tours";

const TOUR_ID = "7a100000-0000-4000-8000-00000000000a";

function issues(result: { success: boolean; error?: { issues: Array<{ path: PropertyKey[]; message: string }> } }) {
  return Object.fromEntries((result.error?.issues ?? []).map((issue) => [issue.path.join("."), issue.message]));
}

describe("tourSchema", () => {
  it("turns form strings into column values", () => {
    expect(
      tourSchema.parse({ name: " Volcán ", description: "", durationMinutes: "180", defaultCapacity: "12", meetingPoint: " Plaza " }),
    ).toEqual({ name: "Volcán", description: null, durationMinutes: 180, defaultCapacity: 12, meetingPoint: "Plaza" });
  });

  it("rejects an empty name, a zero capacity and a non-numeric duration", () => {
    const result = tourSchema.safeParse({ name: " ", description: "", durationMinutes: "3h", defaultCapacity: "0", meetingPoint: "" });
    expect(issues(result)).toEqual({
      name: "validation.nameRequired",
      durationMinutes: "validation.durationInvalid",
      defaultCapacity: "validation.capacityInvalid",
    });
  });

  it("parses the archive flag", () => {
    expect(tourArchiveSchema.parse({ tourId: TOUR_ID, archived: "true" })).toEqual({ tourId: TOUR_ID, archived: true });
    expect(tourArchiveSchema.safeParse({ tourId: "x", archived: "true" }).success).toBe(false);
  });
});

describe("tourPriceSchema", () => {
  it("stores the amount in minor units of the currency", () => {
    expect(tourPriceSchema.parse({ tourId: TOUR_ID, channel: "direct", currency: "usd", amount: "125.50" })).toEqual({
      tourId: TOUR_ID,
      channel: "direct",
      currency: "USD",
      priceMinor: 12550,
    });
    expect(tourPriceSchema.parse({ tourId: TOUR_ID, channel: "viator", currency: "JPY", amount: "1500" }).priceMinor).toBe(1500);
  });

  it("reports a bad amount on the amount field and rejects unknown channels", () => {
    expect(issues(tourPriceSchema.safeParse({ tourId: TOUR_ID, channel: "direct", currency: "USD", amount: "12.345" }))).toEqual({
      amount: "validation.priceInvalid",
    });
    expect(issues(tourPriceSchema.safeParse({ tourId: TOUR_ID, channel: "airbnb", currency: "USD", amount: "1" }))).toEqual({
      channel: "validation.channelInvalid",
    });
  });
});

describe("scheduleSchema", () => {
  const base = { tourId: TOUR_ID, weekday: "2", startTime: "08:00", capacityOverride: "", validFrom: "2026-11-01", validTo: "" };

  it("parses a weekly schedule", () => {
    expect(scheduleSchema.parse(base)).toEqual({
      tourId: TOUR_ID,
      weekday: 2,
      startTime: "08:00",
      capacityOverride: null,
      validFrom: "2026-11-01",
      validTo: null,
    });
    expect(scheduleSchema.parse({ ...base, capacityOverride: "6", validTo: "2026-12-31" })).toMatchObject({
      capacityOverride: 6,
      validTo: "2026-12-31",
    });
  });

  it("rejects a window that ends before it starts, a bad weekday and a bad time", () => {
    expect(issues(scheduleSchema.safeParse({ ...base, validTo: "2026-10-31" }))).toEqual({ validTo: "validation.validToBeforeFrom" });
    expect(issues(scheduleSchema.safeParse({ ...base, weekday: "7", startTime: "25:00" }))).toEqual({
      weekday: "validation.weekdayInvalid",
      startTime: "validation.timeInvalid",
    });
  });
});

describe("departure schemas", () => {
  it("an empty capacity and guide mean the tour default and no guide", () => {
    expect(departureCreateSchema.parse({ tourId: TOUR_ID, date: "2026-11-20", startTime: "14:30", capacity: "", guideId: "" })).toEqual({
      tourId: TOUR_ID,
      date: "2026-11-20",
      startTime: "14:30",
      capacity: null,
      guideId: null,
    });
  });

  it("requires a real date, a tour and a valid guide id", () => {
    expect(
      issues(departureCreateSchema.safeParse({ tourId: "", date: "2026-02-30", startTime: "14:30", capacity: "", guideId: "nope" })),
    ).toEqual({ tourId: "validation.tourRequired", date: "validation.dateInvalid", guideId: "validation.guideInvalid" });
  });

  it("an edit requires the capacity", () => {
    const departureId = "00000000-0000-4000-8000-000000000001";
    expect(
      issues(departureUpdateSchema.safeParse({ departureId, date: "2026-11-20", startTime: "14:30", capacity: "", guideId: "" })),
    ).toEqual({ capacity: "validation.capacityInvalid" });
  });
});
