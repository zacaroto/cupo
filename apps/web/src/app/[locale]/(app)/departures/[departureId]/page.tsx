import { can } from "@cupo/shared/permissions";
import { departureIdSchema } from "@cupo/shared/schemas/tours";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { ActionButton } from "@/components/forms/action-button";
import { DepartureForm } from "@/components/forms/departure-form";
import { Link } from "@/i18n/navigation";
import { pageLocale } from "@/i18n/params";
import { getDeparture } from "@/lib/dal/departures";
import { listGuides } from "@/lib/dal/guides";
import { requirePageContext } from "@/lib/dal/page";
import { formatInstant, formatLocalDate } from "@/lib/format";
import { cancelDepartureAction, closeDepartureAction } from "../actions";

type Props = { params: Promise<{ locale: string; departureId: string }> };

const STATUS_BADGE = { scheduled: "badge-confirmed", closed: "badge-pending", cancelled: "badge-cancelled" } as const;

// One departure (U5, R17, R18, KTD13): staff read it; administradores edit
// date, time, capacity and guide, close it (no new reservations) or cancel
// it. Closed and cancelled are terminal in Phase 1.
export default async function DeparturePage({ params }: Props) {
  const locale = await pageLocale(params);
  const ctx = await requirePageContext(locale, "departures.read");
  const { departureId } = await params;
  if (!departureIdSchema.safeParse({ departureId }).success) notFound();
  const departure = await getDeparture(ctx, departureId);
  if (!departure) notFound();

  const canWrite = can(ctx.role, "departures.write");
  const [t, guides] = await Promise.all([getTranslations("departures"), canWrite ? listGuides(ctx) : Promise.resolve([])]);
  // Active guides, plus the assigned one even if inactive since, so saving keeps it.
  const guideChoices = guides
    .filter((guide) => guide.active || guide.id === departure.guideId)
    .map((guide) => ({ id: guide.id, name: guide.active ? guide.name : t("form.inactiveGuide", { name: guide.name }) }));
  const available = Math.max(0, departure.capacity - departure.seatsBooked);

  const details: Array<[string, string]> = [
    [t("fields.tour"), departure.tourName ?? t("none")],
    [t("fields.date"), formatLocalDate(departure.date, locale)],
    [t("fields.startTime"), departure.startTime],
    [t("fields.startsAt"), formatInstant(departure.startsAt, locale, ctx.operator.timezone)],
    [t("fields.capacity"), String(departure.capacity)],
    [t("fields.seats"), t("seats", { booked: departure.seatsBooked, capacity: departure.capacity })],
    [t("fields.available"), String(available)],
    [t("fields.origin"), t(`origin.${departure.origin}`)],
    [t("fields.guide"), departure.guideName ?? t("none")],
  ];

  return (
    <section className="flex flex-col gap-6">
      <Link href="/departures" className="text-small text-accent hover:underline">
        {t("back")}
      </Link>
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-heading font-semibold tracking-tight text-text">
          {departure.tourName ?? t("title")} · <span className="capitalize">{formatLocalDate(departure.date, locale)}</span> · {departure.startTime}
        </h1>
        <span className={`rounded-full px-2 py-0.5 text-label ${STATUS_BADGE[departure.status]}`} data-status={departure.status}>
          {t(`status.${departure.status}`)}
        </span>
      </header>

      <div className="flex flex-col gap-3 rounded border border-border bg-surface p-4">
        <h2 className="text-small font-semibold text-text">{t("details")}</h2>
        <dl className="grid gap-x-6 gap-y-2 text-small sm:grid-cols-[max-content_1fr]">
          {details.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-muted">{label}</dt>
              <dd className="text-text">{value}</dd>
            </div>
          ))}
        </dl>
      </div>

      {canWrite && departure.status !== "cancelled" ? (
        <div className="flex flex-col gap-3 rounded border border-border bg-surface p-4">
          <h2 className="text-small font-semibold text-text">{t("edit")}</h2>
          <DepartureForm
            key={departure.id}
            mode="edit"
            locale={locale}
            departureId={departure.id}
            guides={guideChoices}
            initial={{
              date: departure.date,
              startTime: departure.startTime,
              capacity: String(departure.capacity),
              guideId: departure.guideId ?? "",
            }}
          />
        </div>
      ) : null}

      {canWrite && departure.status !== "cancelled" ? (
        <div className="flex flex-col gap-3 rounded border border-border bg-surface p-4">
          <h2 className="text-small font-semibold text-text">{t("lifecycle.title")}</h2>
          {departure.status === "scheduled" ? (
            <div className="flex flex-col gap-1">
              <p className="text-small text-muted">{t("lifecycle.closeDescription")}</p>
              <div>
                <ActionButton
                  action={closeDepartureAction}
                  fields={{ departureId: departure.id }}
                  label={t("lifecycle.close")}
                  confirmMessage={t("lifecycle.closeConfirm")}
                />
              </div>
            </div>
          ) : null}
          <div className="flex flex-col gap-1">
            <p className="text-small text-muted">{t("lifecycle.cancelDescription")}</p>
            <div>
              <ActionButton
                action={cancelDepartureAction}
                fields={{ departureId: departure.id }}
                label={t("lifecycle.cancel")}
                confirmMessage={t("lifecycle.cancelConfirm")}
                tone="danger"
              />
            </div>
          </div>
        </div>
      ) : null}
      {departure.status === "cancelled" ? <p className="text-small text-muted">{t("lifecycle.cancelledNotice")}</p> : null}
    </section>
  );
}
