import { getTranslations } from "next-intl/server";
import { can, type Role } from "@cupo/shared/permissions";
import { NavLink } from "./nav-link";
import { NAV_SECTIONS } from "./nav-sections";

// Role-aware navigation (KTD4): a section is listed only when the role holds
// its read action. Hiding is UX; every page checks the same action again.
export async function Nav({ role }: { role: Role }) {
  const t = await getTranslations("shell");
  const sections = NAV_SECTIONS.filter((section) => can(role, section.action));
  return (
    <nav aria-label={t("navLabel")} className="md:w-48 md:shrink-0">
      <ul className="flex flex-wrap gap-1 md:flex-col" data-nav-role={role}>
        {sections.map((section) => (
          <li key={section.key} data-nav-section={section.key}>
            <NavLink href={section.href} label={t(`nav.${section.key}`)} />
          </li>
        ))}
      </ul>
    </nav>
  );
}
