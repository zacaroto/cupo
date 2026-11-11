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
