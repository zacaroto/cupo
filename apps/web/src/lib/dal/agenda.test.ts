import { describe, expect, it, vi } from "vitest";

// agenda.ts is server-only; the grouping is pure and tested here without a
// database.
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));

import { groupByLocalDate } from "./agenda";

const COSTA_RICA = "America/Costa_Rica";

function departure(id: string, startsAt: string) {
  return { id, startsAt };
}

describe("groupByLocalDate", () => {
  it("puts a 23:30 UTC start of a Costa Rica operator on the previous local day", () => {
    const days = groupByLocalDate([departure("late", "2026-11-18T23:30:00Z")], COSTA_RICA);
    expect(days).toEqual([{ date: "2026-11-18", departures: [departure("late", "2026-11-18T23:30:00Z")] }]);
    // 00:30 UTC on the 19th is 18:30 on the 18th in Costa Rica (UTC-6).
    expect(groupByLocalDate([departure("after", "2026-11-19T00:30:00Z")], COSTA_RICA).map((day) => day.date)).toEqual([
      "2026-11-18",
    ]);
  });

  it("groups by local day in chronological order, whatever the input order", () => {
    const days = groupByLocalDate(
      [
        departure("thu-morning", "2026-11-19T14:00:00Z"),
        // 05:59 UTC on the 19th is still 23:59 on the 18th in Costa Rica.
        departure("wed-night", "2026-11-19T05:59:00Z"),
        departure("wed-morning", "2026-11-18T14:00:00Z"),
        // 06:00 UTC on the 19th is midnight on the 19th.
        departure("thu-midnight", "2026-11-19T06:00:00Z"),
      ],
      COSTA_RICA,
    );
    expect(days.map((day) => [day.date, day.departures.map((d) => d.id)])).toEqual([
      ["2026-11-18", ["wed-morning", "wed-night"]],
      ["2026-11-19", ["thu-midnight", "thu-morning"]],
    ]);
  });

  it("uses the operator's zone, not the server's: the same instant lands on different days elsewhere", () => {
    const instant = "2026-11-18T23:30:00Z";
    expect(groupByLocalDate([departure("x", instant)], "Europe/Madrid")[0].date).toBe("2026-11-19");
    expect(groupByLocalDate([departure("x", instant)], "UTC")[0].date).toBe("2026-11-18");
  });

  it("returns no days for no departures", () => {
    expect(groupByLocalDate([], COSTA_RICA)).toEqual([]);
  });
});
