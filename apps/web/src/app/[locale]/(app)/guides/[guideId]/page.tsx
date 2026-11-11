import { can } from "@cupo/shared/permissions";
import { guideIdSchema } from "@cupo/shared/schemas/guides";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { ActionButton } from "@/components/forms/action-button";
import { GuideForm } from "@/components/forms/guide-form";
import { Link } from "@/i18n/navigation";
import { pageLocale } from "@/i18n/params";
import { getGuide } from "@/lib/dal/guides";
import { findMembershipOfUser } from "@/lib/dal/members";
import { requirePageContext } from "@/lib/dal/page";
import { sendGuideAccessAction, setGuideActiveAction } from "../actions";

type Props = { params: Promise<{ locale: string; guideId: string }> };

// One guide (U4, R19): administradores edit it, send access and (de)activate
// it; reservas and contabilidad read it.
export default async function GuidePage({ params }: Props) {
  const locale = await pageLocale(params);
  const ctx = await requirePageContext(locale, "guides.read");
  const { guideId } = await params;
  if (!guideIdSchema.safeParse({ guideId }).success) notFound();
  const guide = await getGuide(ctx, guideId);
  if (!guide) notFound();

  const t = await getTranslations("guides");
  const canWrite = can(ctx.role, "guides.write");
  const canGrant = can(ctx.role, "members.invite");
  const membership = canGrant && guide.userId ? await findMembershipOfUser(ctx, guide.userId) : null;
  const hasAccess = membership?.role === "guia";
  const accessText = !guide.active
    ? t("access.inactive")
    : hasAccess
      ? t("access.granted")
      : guide.userId
        ? t("access.linked")
        : t("access.none");

  const details: Array<[string, string]> = [
    [t("fields.email"), guide.email ?? t("none")],
    [t("fields.phone"), guide.phone ?? t("none")],
    [t("fields.languages"), guide.languages.join(", ") || t("none")],
    [t("fields.specialties"), guide.specialties.join(", ") || t("none")],
    [t("fields.maxDailyHours"), guide.maxDailyHours?.toString() ?? t("none")],
  ];

  return (
    <section className="flex flex-col gap-6">
      <Link href="/guides" className="text-small text-accent hover:underline">
        {t("back")}
      </Link>
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-heading font-semibold tracking-tight text-text">{guide.name}</h1>
        <span className={`rounded-full px-2 py-0.5 text-label ${guide.active ? "badge-confirmed" : "badge-cancelled"}`}>
          {guide.active ? t("status.active") : t("status.inactive")}
        </span>
      </header>

      <div className="flex flex-col gap-3 rounded border border-border bg-surface p-4">
        <h2 className="text-small font-semibold text-text">{t("edit")}</h2>
        {canWrite ? (
          <GuideForm
            mode="edit"
            locale={locale}
            guideId={guide.id}
            initial={{
              name: guide.name,
              email: guide.email ?? "",
              phone: guide.phone ?? "",
              languages: guide.languages.join(", "),
              specialties: guide.specialties.join(", "),
              maxDailyHours: guide.maxDailyHours?.toString() ?? "",
            }}
          />
        ) : (
          <dl className="grid gap-x-6 gap-y-2 text-small sm:grid-cols-[max-content_1fr]">
            {details.map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="text-muted">{label}</dt>
                <dd className="text-text">{value}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>

      {canGrant ? (
        <div className="flex flex-col gap-2 rounded border border-border bg-surface p-4">
          <h2 className="text-small font-semibold text-text">{t("access.title")}</h2>
          <p className="text-small text-muted" data-access-state={hasAccess ? "granted" : guide.userId ? "linked" : "none"}>
            {accessText}
          </p>
          {guide.active && !guide.email ? <p className="text-small text-warning">{t("access.emailRequired")}</p> : null}
          {guide.active && guide.email ? (
            <div>
              <ActionButton
                action={sendGuideAccessAction}
                fields={{ guideId: guide.id }}
                label={hasAccess ? t("access.resend") : t("access.send")}
                doneMessage={t("access.sent")}
              />
            </div>
          ) : null}
        </div>
      ) : null}

      {canWrite ? (
        <div className="flex flex-col gap-2 rounded border border-border bg-surface p-4">
          <h2 className="text-small font-semibold text-text">{t("activation.title")}</h2>
          <p className="text-small text-muted">
            {guide.active ? t("activation.activeDescription") : t("activation.inactiveDescription")}
          </p>
          <div>
            {guide.active ? (
              <ActionButton
                action={setGuideActiveAction}
                fields={{ guideId: guide.id, active: "false" }}
                label={t("activation.deactivate")}
                confirmMessage={t("activation.deactivateConfirm", { name: guide.name })}
                tone="danger"
              />
            ) : (
              <ActionButton
                action={setGuideActiveAction}
                fields={{ guideId: guide.id, active: "true" }}
                label={t("activation.reactivate")}
              />
            )}
          </div>
        </div>
      ) : null}
    </section>
  );
}
