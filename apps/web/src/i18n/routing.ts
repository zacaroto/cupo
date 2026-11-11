import { defineRouting } from "next-intl/routing";

export const routing = defineRouting({
  locales: ["es", "en"],
  defaultLocale: "es",
  // Spanish first: "/" and unprefixed paths always go to the default locale
  // instead of following Accept-Language (the U1 behaviour of "/" -> "/es").
  // A user switches language through the URL prefix.
  localeDetection: false,
});

export type Locale = (typeof routing.locales)[number];
