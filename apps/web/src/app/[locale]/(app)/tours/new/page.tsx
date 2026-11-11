import { getTranslations } from "next-intl/server";
import { TourForm } from "@/components/forms/tour-form";
import { Link } from "@/i18n/navigation";
import { pageLocale } from "@/i18n/params";
import { requirePageContext } from "@/lib/dal/page";

type Props = { params: Promise<{ locale: string }> };

// New tour (U5, R15): administradores only. Prices and schedules are added on
// the tour page the form opens.
export default async function NewTourPage({ params }: Props) {
  const locale = await pageLocale(params);
  await requirePageContext(locale, "tours.write");
  const t = await getTranslations("tours");

  return (
    <section className="flex flex-col gap-6">
      <Link href="/tours" className="text-small text-accent hover:underline">
        {t("back")}
      </Link>
      <header className="flex flex-col gap-1">
        <h1 className="text-heading font-semibold tracking-tight text-text">{t("newTitle")}</h1>
        <p className="text-small text-muted">{t("newDescription")}</p>
      </header>
      <div className="rounded border border-border bg-surface p-4">
        <TourForm mode="create" locale={locale} />
      </div>
    </section>
  );
}
