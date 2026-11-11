import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";

// KTD12: localized 404. Rendered inside the [locale] layout (same <html lang>)
// whenever notFound() is thrown under a valid locale, e.g. by [...rest]/page.tsx.
export default async function NotFound() {
  const t = await getTranslations("common.notFound");

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col items-center justify-center gap-4 px-4 py-16 text-center">
      <p className="text-sm font-medium uppercase tracking-wide text-muted">404</p>
      <h1 className="text-heading font-semibold tracking-tight text-text">{t("title")}</h1>
      <p className="text-body text-muted">{t("description")}</p>
      <Link href="/" className="btn-secondary mt-2 text-small">
        {t("backHome")}
      </Link>
    </main>
  );
}
