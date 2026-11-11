import { describe, expect, it } from "vitest";
import { addDays, isIsoDate, normalizeLocalTime, todayIn, weekdayOf } from "./local-date";

describe("local dates and times", () => {
  it("accepts real calendar dates only", () => {
    expect(isIsoDate("2026-11-17")).toBe(true);
    expect(isIsoDate("2028-02-29")).toBe(true);
    expect(isIsoDate("2026-02-29")).toBe(false);
    expect(isIsoDate("2026-13-01")).toBe(false);
    expect(isIsoDate("17/11/2026")).toBe(false);
  });

  it("normalizes whole-minute times to HH:MM", () => {
    expect(normalizeLocalTime("08:00")).toBe("08:00");
    expect(normalizeLocalTime("08:00:00")).toBe("08:00");
    expect(normalizeLocalTime("23:59")).toBe("23:59");
    expect(normalizeLocalTime("08:00:30")).toBeNull();
    expect(normalizeLocalTime("24:00")).toBeNull();
    expect(normalizeLocalTime("8:00")).toBeNull();
  });

  it("weekday follows extract(dow): 0 is Sunday", () => {
    expect(weekdayOf("2026-11-15")).toBe(0);
    expect(weekdayOf("2026-11-17")).toBe(2);
    expect(weekdayOf("2026-11-21")).toBe(6);
  });

  it("adds calendar days across months and years", () => {
    expect(addDays("2026-12-30", 3)).toBe("2027-01-02");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("reads today in the operator's zone, not the server's", () => {
    const instant = new Date("2026-11-18T03:30:00Z");
    expect(todayIn("America/Costa_Rica", instant)).toBe("2026-11-17");
    expect(todayIn("Europe/Madrid", instant)).toBe("2026-11-18");
  });
});
