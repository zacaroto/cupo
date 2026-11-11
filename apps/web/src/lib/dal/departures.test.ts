import { describe, expect, it, vi } from "vitest";

// departures.ts is server-only; the slot derivation is pure and tested here
// without a database.
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));

import { defaultDepartureWindow, deriveDepartureSlots } from "./departures";
import type { TourSchedule } from "./tours";

// 2026-11-17 is a Tuesday (weekday 2).
const TUESDAY = "2026-11-17";

function schedule(fields: Partial<TourSchedule> & Pick<TourSchedule, "weekday" | "startTime">): TourSchedule {
  return { id: `s-${fields.weekday}-${fields.startTime}`, capacityOverride: null, validFrom: "2026-01-01", validTo: null, ...fields };
}

describe("deriveDepartureSlots", () => {
  it("lists the Tuesday schedules within validity plus existing departures, one per start time, without cancelled rows", () => {
    const slots = deriveDepartureSlots({
      date: TUESDAY,
      defaultCapacity: 12,
      schedules: [
        schedule({ weekday: 2, startTime: "08:00" }),
        schedule({ weekday: 2, startTime: "13:00", capacityOverride: 6 }),
        // other weekday
        schedule({ weekday: 3, startTime: "09:00" }),
        // validity window ended before the date
        schedule({ weekday: 2, startTime: "10:00", validTo: "2026-11-16" }),
        // validity window starts after the date
        schedule({ weekday: 2, startTime: "11:00", validFrom: "2026-11-18" }),
        // window edges are inclusive
        schedule({ weekday: 2, startTime: "15:00", validFrom: TUESDAY, validTo: TUESDAY }),
      ],
      departures: [
        // materialized schedule slot: the departure wins (its own capacity and seats)
        { id: "d-0800", startTime: "08:00", status: "scheduled", origin: "schedule", capacity: 10, seatsBooked: 4 },
        // ad hoc departure at a time with no schedule
        { id: "d-1630", startTime: "16:30", status: "closed", origin: "ad_hoc", capacity: 5, seatsBooked: 5 },
        // cancelled departures do not take the slot (13:00 stays the schedule)
        { id: "d-1300", startTime: "13:00", status: "cancelled", origin: "schedule", capacity: 6, seatsBooked: 0 },
        { id: "d-1800", startTime: "18:00", status: "cancelled", origin: "ad_hoc", capacity: 6, seatsBooked: 0 },
      ],
    });

    expect(slots).toEqual([
      { startTime: "08:00", departureId: "d-0800", status: "scheduled", origin: "schedule", capacity: 10, seatsBooked: 4, available: 6 },
      { startTime: "13:00", departureId: null, status: null, origin: "schedule", capacity: 6, seatsBooked: 0, available: 6 },
      { startTime: "15:00", departureId: null, status: null, origin: "schedule", capacity: 12, seatsBooked: 0, available: 12 },
      { startTime: "16:30", departureId: "d-1630", status: "closed", origin: "ad_hoc", capacity: 5, seatsBooked: 5, available: 0 },
    ]);
  });

  it("returns nothing for a day without schedules or departures", () => {
    expect(
      deriveDepartureSlots({ date: "2026-11-18", defaultCapacity: 12, schedules: [schedule({ weekday: 2, startTime: "08:00" })], departures: [] }),
    ).toEqual([]);
  });
});

describe("defaultDepartureWindow", () => {
  it("spans today and the next two weeks", () => {
    expect(defaultDepartureWindow("2026-12-25")).toEqual({ from: "2026-12-25", to: "2027-01-08" });
  });
});
