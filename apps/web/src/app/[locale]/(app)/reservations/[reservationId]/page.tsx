import { isIsoDate } from "@cupo/shared/local-date";
import { formatMinor } from "@cupo/shared/money";
import { can } from "@cupo/shared/permissions";
import { DEPARTURE_CANCELLED_REASON, slotValue } from "@cupo/shared/schemas/reservations";
import { getTranslations } from "next-intl/server";
import Form from "next/form";
import { notFound } from "next/navigation";
import { z } from "zod";
import { CancelReservationForm } from "@/components/forms/cancel-reservation-form";
import { EditReservationForm, type EditSlotOption } from "@/components/forms/edit-reservation-form";
import { ReservationHistory } from "@/components/reservations/history";
import { getPathname, Link } from "@/i18n/navigation";
import { pageLocale } from "@/i18n/params";
import { getReservationHistory } from "@/lib/dal/audit";
import { listDepartureSlots } from "@/lib/dal/departures";
import { requirePageContext } from "@/lib/dal/page";
import { getReservation } from "@/lib/dal/reservations";
import { formatInstant, formatLocalDate } from "@/lib/format";

type Props = {
  params: Promise<{ locale: string; reservationId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

const STATUS_BADGE = { pending_review: "badge-pending", confirmed: "badge-confirmed", cancelled: "badge-cancelled" } as const;

const uuid = z.uuid();

function single(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

// One reservation (U10, R11, R23, R29). Every staff role reads it; the
// customer is full or masked, and notes and amount show, by role (KTD4).
// Administradores and reservas edit people, the slot within the tour and the
// notes, or cancel with a reason; a cancelled reservation is read-only.
// Administradores also see the change history. The edit's slots are read on
// the server for the date in `?date=` (the departure's date by default).
export default async function ReservationPage({ params, searchParams }: Props) {
  const locale = await pageLocale(params);
  const ctx = await requirePageContext(locale, "reservations.read");
  const { reservationId } = await params;
  if (!uuid.safeParse(reservationId).success) notFound();
  const reservation = await getReservation(ctx, reservationId);
  if (!reservation) notFound();

  const cancelled = reservation.status === "cancelled";
  const canWrite = can(ctx.role, "reservations.write") && !cancelled;
  const search = await searchParams;
  const editDate = isIsoDate(single(search.date)) ? single(search.date) : reservation.date;

  const [t, tr, th, slots, history] = await Promise.all([
    getTranslations("reservationDetail"),
    getTranslations("reservations"),
    getTranslations("history"),
    canWrite ? listDepartureSlots(ctx, reservation.tourId, editDate) : Promise.resolve(null),
    can(ctx.role, "audit.read") ? getReservationHistory(ctx, reservation.id) : Promise.resolve(null),
  ]);
  const editSlots: EditSlotOption[] = (slots ?? []).map((slot) => ({
    value: slotValue(slot),
    startTime: slot.startTime,
    available: slot.available,
    closed: slot.status === "closed",
    current: slot.departureId === reservation.departureId,
  }));
  const contact = reservation.customerContact
    ? [reservation.customerContact.email, reservation.customerContact.phone].filter(Boolean).join(" · ")
    : "";

  return (
    <section className="flex flex-col gap-6">
      <Link href="/reservations" className="text-small text-accent hover:underline">
        {t("back")}
      </Link>
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-heading font-semibold tracking-tight text-text">{t("title", { code: reservation.code })}</h1>
        <span className={`rounded-full px-2 py-0.5 text-label ${STATUS_BADGE[reservation.status]}`} data-status={reservation.status}>
          {tr(`status.${reservation.status}`)}
        </span>
        {reservation.hasIncompleteData ? (
          <span className="badge-pending rounded-full px-2 py-0.5 text-label" title={tr("incompleteHint")}>
            {tr("incomplete")}
          </span>
        ) : null}
      </header>

      <div className="flex flex-col gap-3 rounded border border-border bg-surface p-4">
        <h2 className="text-small font-semibold text-text">{t("details")}</h2>
        <dl className="grid gap-x-6 gap-y-2 text-small sm:grid-cols-[max-content_1fr]">
          <dt className="text-muted">{t("fields.tour")}</dt>
          <dd className="text-text">{reservation.tourName ?? tr("none")}</dd>
          <dt className="text-muted">{t("fields.departure")}</dt>
          <dd className="text-text">
            <Link href={`/departures/${reservation.departureId}`} className="capitalize text-accent hover:underline">
              {t("departure", { date: formatLocalDate(reservation.date, locale), time: reservation.startTime })}
            </Link>
            {reservation.departureStatus === "closed" ? <span className="text-muted"> · {t("departureClosed")}</span> : null}
          </dd>
          <dt className="text-muted">{t("fields.customer")}</dt>
          <dd className="text-text" data-customer>
            <span className="font-medium">{reservation.customerName ?? tr("none")}</span>
            {contact ? <span className="block text-label text-muted">{contact}</span> : null}
          </dd>
          <dt className="text-muted">{t("fields.people")}</dt>
          <dd className="text-text" data-people>
            {reservation.people}
          </dd>
          <dt className="text-muted">{t("fields.status")}</dt>
          <dd className="text-text">{tr(`status.${reservation.status}`)}</dd>
          {reservation.cancelReason ? (
            <>
              <dt className="text-muted">{t("fields.cancelReason")}</dt>
              <dd className="text-text" data-cancel-reason>
                {reservation.cancelReason === DEPARTURE_CANCELLED_REASON ? tr("cancelReason.departure_cancelled") : reservation.cancelReason}
              </dd>
            </>
          ) : null}
          {reservation.amount ? (
            <>
              <dt className="text-muted">{t("fields.amount")}</dt>
              <dd className="text-text" data-amount>
                {formatMinor(reservation.amount.totalMinor, reservation.amount.currency, locale)}
                {reservation.amount.overridden ? <span className="text-muted"> · {tr("overridden")}</span> : null}
              </dd>
            </>
          ) : null}
          <dt className="text-muted">{t("fields.createdAt")}</dt>
          <dd className="text-text">{formatInstant(reservation.createdAt, locale, ctx.operator.timezone)}</dd>
        </dl>
      </div>

      {reservation.notes !== undefined ? (
        <div className="flex flex-col gap-2 rounded border border-border bg-surface p-4">
          <h2 className="text-small font-semibold text-text">{t("notes")}</h2>
          {reservation.notes ? (
            <p className="whitespace-pre-wrap text-small text-text" data-notes>
              {reservation.notes}
            </p>
          ) : (
            <p className="text-small text-muted">{t("noNotes")}</p>
          )}
        </div>
      ) : null}

      {cancelled ? <p className="text-small text-muted">{t("cancelledNotice")}</p> : null}

      {canWrite ? (
        <div className="flex flex-col gap-4 rounded border border-border bg-surface p-4">
          <div className="flex flex-col gap-1">
            <h2 className="text-small font-semibold text-text">{t("edit.title")}</h2>
            <p className="text-small text-muted">{t("edit.description")}</p>
          </div>
          <Form action={getPathname({ href: `/reservations/${reservation.id}`, locale })} className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1">
              <label htmlFor="edit-reservation-date" className="text-small font-medium text-text">
                {t("edit.dateLabel")}
              </label>
              <input id="edit-reservation-date" name="date" type="date" defaultValue={editDate} required className="field" />
            </div>
            <button type="submit" className="btn-secondary px-3 py-2 text-small">
              {t("edit.showSlots")}
            </button>
          </Form>
          <EditReservationForm
            key={editDate}
            reservationId={reservation.id}
            date={editDate}
            slots={editSlots}
            initial={{ people: String(reservation.people), notes: reservation.notes ?? "" }}
          />
        </div>
      ) : null}

      {canWrite ? (
        <div className="flex flex-col gap-2 rounded border border-border bg-surface p-4">
          <h2 className="text-small font-semibold text-text">{t("cancel.title")}</h2>
          <p className="text-small text-muted">{t("cancel.description")}</p>
          <CancelReservationForm reservationId={reservation.id} code={reservation.code} />
        </div>
      ) : null}

      {history ? (
        <div className="flex flex-col gap-3 rounded border border-border bg-surface p-4">
          <div className="flex flex-col gap-1">
            <h2 className="text-small font-semibold text-text">{th("title")}</h2>
            <p className="text-small text-muted">{th("description", { timezone: ctx.operator.timezone })}</p>
          </div>
          <ReservationHistory entries={history} locale={locale} timeZone={ctx.operator.timezone} />
        </div>
      ) : null}
    </section>
  );
}
