import { can } from "@cupo/shared/permissions";
import { getTranslations } from "next-intl/server";
import { GuideForm } from "@/components/forms/guide-form";
import { Link } from "@/i18n/navigation";
import { pageLocale } from "@/i18n/params";
import { listGuides } from "@/lib/dal/guides";
import { listGuiaUserIds } from "@/lib/dal/members";
import { requirePageContext } from "@/lib/dal/page";

type Props = { params: Promise<{ locale: string }> };

// Guide registry (U4, R19): staff read it, administradores add and edit.
export default async function GuidesPage({ params }: Props) {
  const locale = await pageLocale(params);
  const ctx = await requirePageContext(locale, "guides.read");
  const canWrite = can(ctx.role, "guides.write");
  // Only administradores read other members' memberships (RLS), so only they see the access column.
  const showAccess = can(ctx.role, "members.read");
  const [t, guides, guiaUserIds] = await Promise.all([
    getTranslations("guides"),
    listGuides(ctx),
    showAccess ? listGuiaUserIds(ctx) : Promise.resolve(new Set<string>()),
  ]);

  return (
    <section className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-heading font-semibold tracking-tight text-text">{t("title")}</h1>
        <p className="text-small text-muted">{t("description")}</p>
      </header>

      {canWrite ? (
        <details className="rounded border border-border bg-surface p-4">
          <summary className="cursor-pointer text-small font-semibold text-text">{t("new")}</summary>
          <div className="pt-3">
            <GuideForm mode="create" locale={locale} />
          </div>
        </details>
      ) : null}

      {guides.length === 0 ? (
        <p className="text-small text-muted">{t("empty")}</p>
      ) : (
        <div className="overflow-x-auto rounded border border-border bg-surface">
          <table className="w-full text-left text-small">
            <caption className="sr-only">{t("title")}</caption>
            <thead className="border-b border-border text-label text-muted">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">{t("fields.name")}</th>
                <th scope="col" className="px-3 py-2 font-medium">{t("fields.email")}</th>
                <th scope="col" className="px-3 py-2 font-medium">{t("fields.phone")}</th>
                <th scope="col" className="px-3 py-2 font-medium">{t("fields.languages")}</th>
                <th scope="col" className="px-3 py-2 font-medium">{t("fields.status")}</th>
                {showAccess ? <th scope="col" className="px-3 py-2 font-medium">{t("fields.access")}</th> : null}
              </tr>
            </thead>
            <tbody>
              {guides.map((guide) => (
                <tr key={guide.id} className="border-b border-rule last:border-b-0" data-guide-id={guide.id}>
                  <td className="px-3 py-2">
                    <Link href={`/guides/${guide.id}`} className="font-medium text-accent hover:underline">
                      {guide.name}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-muted">{guide.email ?? t("none")}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-muted">{guide.phone ?? t("none")}</td>
                  <td className="px-3 py-2 text-muted">{guide.languages.length ? guide.languages.join(", ") : t("none")}</td>
                  <td className="px-3 py-2">
                    <span
                      className={`rounded-full px-2 py-0.5 text-label ${guide.active ? "badge-confirmed" : "badge-cancelled"}`}
                    >
                      {guide.active ? t("status.active") : t("status.inactive")}
                    </span>
                  </td>
                  {showAccess ? (
                    <td className="whitespace-nowrap px-3 py-2 text-muted">
                      {guide.userId && guiaUserIds.has(guide.userId) ? t("access.yes") : t("access.no")}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
