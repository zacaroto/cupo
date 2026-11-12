import { describe, expect, it } from "vitest";
import { sectionOf } from "./nav-sections";

const LOCALES = ["es", "en"];

describe("sectionOf", () => {
  it("returns the first segment after the locale", () => {
    expect(sectionOf("/es/agenda", LOCALES)).toBe("agenda");
    expect(sectionOf("/en/reservations/new", LOCALES)).toBe("reservations");
    expect(sectionOf("/es/departures/0a000000-0000-4000-8000-00000000000a/", LOCALES)).toBe("departures");
  });

  it("returns null for the home page, with or without the locale", () => {
    expect(sectionOf("/es", LOCALES)).toBeNull();
    expect(sectionOf("/es/", LOCALES)).toBeNull();
    expect(sectionOf("/", LOCALES)).toBeNull();
  });

  it("reads an unprefixed path from its first segment", () => {
    expect(sectionOf("/agenda", LOCALES)).toBe("agenda");
  });
});
