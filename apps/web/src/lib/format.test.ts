import { describe, expect, it } from "vitest";
import { formatInstant, formatLocalDate, weekdayName } from "./format";

describe("local display formatting", () => {
  it("formats a local date without shifting the day", () => {
    expect(formatLocalDate("2026-11-17", "en")).toBe("Tue, Nov 17, 2026");
    expect(formatLocalDate("2026-01-01", "en")).toContain("Jan 1, 2026");
  });

  it("names weekdays from 0 = Sunday", () => {
    expect(weekdayName(0, "en")).toBe("Sunday");
    expect(weekdayName(2, "en")).toBe("Tuesday");
    expect(weekdayName(6, "es")).toBe("sábado");
  });

  it("shows an instant in the operator's zone", () => {
    expect(formatInstant("2026-11-17T14:00:00Z", "en", "America/Costa_Rica")).toMatch(/Nov 17, 2026.*8:00/);
  });
});
