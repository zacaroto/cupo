import { getTranslations } from "next-intl/server";
import type { NavSectionKey } from "./nav-sections";

// Placeholder body for shell sections whose unit has not landed yet
// (U4 members and guides, U5 tours and departures, U6 reservations,
// U7 agenda, U9 customers). Each page already enforces its read action.
export async function SectionPlaceholder({ section }: { section: NavSectionKey }) {
  const t = await getTranslations("shell");
  return (
    <section className="flex flex-col gap-2" data-placeholder={section}>
      <h1 className="text-heading font-semibold tracking-tight text-text">{t(`nav.${section}`)}</h1>
      <p className="text-small text-muted">{t("placeholder.description")}</p>
    </section>
  );
}
