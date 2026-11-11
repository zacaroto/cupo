import { getTranslations, setRequestLocale } from "next-intl/server";
import { hasLocale } from "next-intl";
import { notFound } from "next/navigation";
import { Link } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";

type Props = {
  params: Promise<{ locale: string }>;
};

const FEATURES = ["operators", "capacity", "roles"] as const;

export default async function LandingPage({ params }: Props) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) {
    notFound();
  }
  setRequestLocale(locale);

  const t = await getTranslations("landing");
  const common = await getTranslations("common");
  const otherLocale = locale === "es" ? "en" : "es";

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-10 px-4 py-16">
      <header className="flex items-center justify-between">
        <span className="text-lg font-semibold tracking-tight">{common("appName")}</span>
        <Link
          href="/"
          locale={otherLocale}
          className="text-sm text-muted hover:text-text"
          aria-label={common("language.label")}
        >
          {common(`language.${otherLocale}`)}
        </Link>
      </header>

      <section className="flex flex-col gap-4">
        <p className="text-sm font-medium uppercase tracking-wide text-accent">{t("eyebrow")}</p>
        <h1 className="text-4xl font-semibold tracking-tight text-text">{t("title")}</h1>
        <p className="text-lg text-muted">{t("subtitle")}</p>
        <p className="rounded border border-border bg-surface px-4 py-3 text-sm text-muted">
          {t("status")}
        </p>
      </section>

      <section className="grid gap-4 sm:grid-cols-3">
        {FEATURES.map((key) => (
          <article key={key} className="rounded border border-border bg-surface p-4">
            <h2 className="font-semibold text-text">{t(`features.${key}.title`)}</h2>
            <p className="mt-1 text-sm text-muted">{t(`features.${key}.description`)}</p>
          </article>
        ))}
      </section>
    </main>
  );
}
