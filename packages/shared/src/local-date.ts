// Local calendar dates and wall-clock times (KTD7). Schedules and departures
// store a local `date` (`YYYY-MM-DD`) and `time` (`HH:MM`) in the operator's
// IANA zone; these helpers work on those strings without ever turning them
// into instants, so a server in UTC and an operator in another zone agree.

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const LOCAL_TIME = /^([01]\d|2[0-3]):([0-5]\d)(?::00(?:\.0+)?)?$/;

/** True for a real calendar date in `YYYY-MM-DD` form. */
export function isIsoDate(value: string): boolean {
  const match = ISO_DATE.exec(value);
  if (!match) return false;
  const [, y, m, d] = match.map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/**
 * `HH:MM` for a whole-minute wall-clock time (`08:00`, `08:00:00` from
 * Postgres), or null. Seconds other than zero are rejected, as in the
 * database (`*_start_time_minute`).
 */
export function normalizeLocalTime(value: string): string | null {
  const match = LOCAL_TIME.exec(value.trim());
  return match ? `${match[1]}:${match[2]}` : null;
}

function utcDate(isoDate: string): Date {
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/** 0 = Sunday ... 6 = Saturday, like Postgres `extract(dow)` (the `weekday` column). */
export function weekdayOf(isoDate: string): number {
  return utcDate(isoDate).getUTCDay();
}

/** `isoDate` plus `days` calendar days (negative to go back). */
export function addDays(isoDate: string, days: number): string {
  const date = utcDate(isoDate);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** The calendar date in `timeZone` at the instant `now`. */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}
