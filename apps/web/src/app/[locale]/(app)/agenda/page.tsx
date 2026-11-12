import { getTranslations } from "next-intl/server";
import { pageLocale } from "@/i18n/params";
import { AGENDA_LIMIT, getAgenda } from "@/lib/dal/agenda";
import { requirePageContext } from "@/lib/dal/page";
import { formatLocalDate } from "@/lib/format";

type Props = { params: Promise<{ locale: string }> };

const DEPARTURE_BADGE = { scheduled: "badge-confirmed", closed: "badge-pending", cancelled: "badge-cancelled" } as const;

// The guía's agenda (U7, R11, R20): their future assigned departures by local
// day, each with its non-cancelled reservations and the masked customer names.
// No amounts, notes or contact data reach this page; RLS returns none of them
// to a guía either.
export default async function AgendaPage({ params }: Props) {
  const locale = await pageLocale(params);
  const ctx = await requirePageContext(locale, "agenda.read");
  const [t, agenda] = await Promise.all([getTranslations("agenda"), getAgenda(ctx)]);

  return (
    <section className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-heading font-semibold tracking-tight text-text">{t("title")}</h1>
        <p className="text-small text-muted">{t("description", { timezone: ctx.operator.timezone })}</p>
      </header>

      {agenda.days.length === 0 ? (
        <p className="rounded border border-border bg-surface px-4 py-6 text-center text-small text-muted" data-agenda-empty>
          {t("empty")}
        </p>
      ) : (
        agenda.days.map((day) => (
          <section key={day.date} aria-labelledby={`day-${day.date}`} className="flex flex-col gap-3" data-agenda-day={day.date}>
            <h2 id={`day-${day.date}`} className="text-small font-semibold capitalize text-text">
              {formatLocalDate(day.date, locale)}
            </h2>
            <ul className="flex flex-col gap-3">
              {day.departures.map((departure) => {
                const tour = departure.tourName ?? t("none");
                return (
                  <li key={departure.id} className="rounded border border-border bg-surface" data-departure-id={departure.id}>
                    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 border-b border-rule px-4 py-3">
                      <div className="flex min-w-0 flex-col">
                        <p className="text-body text-text">
                          <span className="font-mono font-semibold">{departure.startTime}</span>
                          <span className="text-muted"> · </span>
                          <span className="font-medium">{tour}</span>
                        </p>
                        {departure.meetingPoint ? (
                          <p className="text-label text-muted">{t("meetingPoint", { place: departure.meetingPoint })}</p>
                        ) : null}
                      </div>
                      <div className="flex flex-wrap items-center gap-2 text-small text-muted">
                        {departure.status !== "scheduled" ? (
                          <span className={`rounded-full px-2 py-0.5 text-label ${DEPARTURE_BADGE[departure.status]}`} data-status={departure.status}>
                            {t(`departureStatus.${departure.status}`)}
                          </span>
                        ) : null}
                        <span>{t("occupancy", { people: departure.people, capacity: departure.capacity })}</span>
                      </div>
                    </div>
                    {departure.reservations.length === 0 ? (
                      <p className="px-4 py-3 text-small text-muted">{t("noReservations")}</p>
                    ) : (
                      <ul aria-label={t("reservationsLabel", { tour, time: departure.startTime })} className="divide-y divide-rule">
                        {departure.reservations.map((reservation) => (
                          <li
                            key={reservation.id}
                            className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-2 text-small"
                            data-reservation-code={reservation.code}
                          >
                            <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                              <span className="font-medium text-text">{reservation.customerName ?? t("none")}</span>
                              <span className="font-mono text-label text-muted">{reservation.code}</span>
                            </span>
                            <span className="flex items-center gap-2">
                              {reservation.status === "pending_review" ? (
                                <span className="badge-pending rounded-full px-2 py-0.5 text-label">{t("pendingReview")}</span>
                              ) : null}
                              <span className="text-text">{t("partySize", { count: reservation.people })}</span>
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        ))
      )}
      {agenda.hasMore ? <p className="text-label text-muted">{t("hasMore", { count: AGENDA_LIMIT })}</p> : null}
    </section>
  );
}
