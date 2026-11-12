import type { Action } from "@cupo/shared/permissions";

/** Shell sections in display order; each shows only when the role holds its read action. */
export const NAV_SECTIONS = [
  { key: "reservations", href: "/reservations", action: "reservations.read" },
  { key: "departures", href: "/departures", action: "departures.read" },
  { key: "tours", href: "/tours", action: "tours.read" },
  { key: "customers", href: "/customers", action: "customers.read" },
  { key: "guides", href: "/guides", action: "guides.read" },
  { key: "members", href: "/members", action: "members.read" },
  { key: "agenda", href: "/agenda", action: "agenda.read" },
] as const satisfies ReadonlyArray<{ key: string; href: `/${string}`; action: Action }>;

export type NavSectionKey = (typeof NAV_SECTIONS)[number]["key"];

/**
 * The first section segment of an app path (`/es/reservations/new` ->
 * `reservations`), skipping the locale prefix; null for the home page.
 */
export function sectionOf(pathname: string, locales: readonly string[]): string | null {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length > 0 && locales.includes(segments[0])) segments.shift();
  return segments[0] ?? null;
}
