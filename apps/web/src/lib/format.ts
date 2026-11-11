// Display formatting for local calendar values (KTD7). Departure and schedule
// dates are local to the operator already, so they are formatted as UTC
// calendar dates: no timezone conversion may shift the day.

/** `2026-11-17` -> `mar, 17 nov 2026` (es) / `Tue, Nov 17, 2026` (en). */
export function formatLocalDate(isoDate: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${isoDate}T00:00:00Z`));
}

/** Weekday name for 0 = Sunday ... 6 = Saturday (the `weekday` column). */
export function weekdayName(weekday: number, locale: string): string {
  // 2026-11-15 is a Sunday.
  return new Intl.DateTimeFormat(locale, { weekday: "long", timeZone: "UTC" }).format(
    new Date(Date.UTC(2026, 10, 15 + weekday)),
  );
}

/** An instant shown in the operator's zone, with the zone name: for derived `starts_at`. */
export function formatInstant(instant: string, locale: string, timeZone: string): string {
  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone,
    timeZoneName: "short",
  }).format(new Date(instant));
}
