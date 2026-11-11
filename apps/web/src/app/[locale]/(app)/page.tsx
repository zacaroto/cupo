import { getTranslations } from "next-intl/server";
import { can } from "@cupo/shared/permissions";
import { NAV_SECTIONS } from "@/components/layout/nav-sections";
import { Link, redirect } from "@/i18n/navigation";
import { pageLocale } from "@/i18n/params";
import { requirePageContext } from "@/lib/dal/page";

type Props = { params: Promise<{ locale: string }> };

// Home of the shell. A guía has only the agenda, so they land there (F5).
export default async function HomePage({ params }: Props) {
  const locale = await pageLocale(params);
  const ctx = await requirePageContext(locale);
  if (ctx.role === "guia") return redirect({ href: "/agenda", locale });

  const t = await getTranslations("shell");
  const common = await getTranslations("common");
  const sections = NAV_SECTIONS.filter((section) => can(ctx.role, section.action));

  return (
    <section className="flex flex-col gap-4">
      <h1 className="text-heading font-semibold tracking-tight text-text">{t("home.title")}</h1>
      <p className="text-body text-muted">
        {t("home.greeting", { operator: ctx.operator.name, role: common(`roles.${ctx.role}`) })}
      </p>
      <h2 className="text-small font-semibold text-text">{t("home.sections")}</h2>
      <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {sections.map((section) => (
          <li key={section.key}>
            <Link
              href={section.href}
              className="block rounded border border-border bg-surface px-4 py-3 text-small font-medium text-text hover:border-faint"
            >
              {t(`nav.${section.key}`)}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
