import { formatMinor } from "@cupo/shared/money";
import { addDays, todayIn } from "@cupo/shared/local-date";
import { can } from "@cupo/shared/permissions";
import {
  DEPARTURE_CANCELLED_REASON,
  RESERVATION_STATUSES,
  reservationFilterSchema,
} from "@cupo/shared/schemas/reservations";
import { getTranslations } from "next-intl/server";
import Form from "next/form";
import { FormMessage } from "@/components/auth/form-message";
import { CancelReservationForm } from "@/components/forms/cancel-reservation-form";
import { getPathname, Link } from "@/i18n/navigation";
import { pageLocale } from "@/i18n/params";
import { requirePageContext } from "@/lib/dal/page";
import { listReservations, RESERVATION_LIST_LIMIT } from "@/lib/dal/reservations";
import { formatLocalDate } from "@/lib/format";

type Props = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

const STATUS_BADGE = { pending_review: "badge-pending", confirmed: "badge-confirmed", cancelled: "badge-cancelled" } as const;

const CODE = /^D-\d{6,}$/;

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

// Reservations of the operator (U6, R11, R22 to R25) by departure date, with
// a status filter. Customer names are full for administrador and reservas and
// masked for contabilidad (the DAL reads customer_display for them); amounts
// show for administrador and contabilidad only. Writers cancel with a reason
// from the row; the detail page and edits arrive with U10.
export default async function ReservationsPage({ params, searchParams }: Props) {
  const locale = await pageLocale(params);
  const ctx = await requirePageContext(locale, "reservations.read");
  const search = await searchParams;
  const filter = reservationFilterSchema.parse({ from: single(search.from), to: single(search.to), status: single(search.status) });
  const today = todayIn(ctx.operator.timezone);
  const from = filter.from ?? today;
  // A missing or inverted end shows a month from the start.
  const to = filter.to && filter.to >= from ? filter.to : addDays(from, 30);
  const created = CODE.test(single(search.created) ?? "") ? single(search.created) : undefined;
  const canWrite = can(ctx.role, "reservations.write");
  const showAmounts = can(ctx.role, "amounts.read");

  const [t, list] = await Promise.all([
    getTranslations("reservations"),
    listReservations(ctx, { from, to, ...(filter.status && { status: filter.status }) }),
  ]);

  return (
    <section className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-heading font-semibold tracking-tight text-text">{t("title")}</h1>
          <p className="text-small text-muted">{t("description", { timezone: ctx.operator.timezone })}</p>
        </div>
        {canWrite ? (
          <Link href="/reservations/new" className="btn-primary text-small">
            {t("new")}
          </Link>
        ) : null}
      </header>

      {created ? <FormMessage tone="status">{t("created", { code: created })}</FormMessage> : null}

      <Form action={getPathname({ href: "/reservations", locale })} className="flex flex-wrap items-end gap-3" aria-label={t("filters.label")}>
        <div className="flex flex-col gap-1">
          <label htmlFor="filter-from" className="text-small font-medium text-text">{t("filters.from")}</label>
          <input id="filter-from" name="from" type="date" defaultValue={from} className="field" />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="filter-to" className="text-small font-medium text-text">{t("filters.to")}</label>
          <input id="filter-to" name="to" type="date" defaultValue={to} className="field" />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="filter-status" className="text-small font-medium text-text">{t("filters.status")}</label>
          <select id="filter-status" name="status" defaultValue={filter.status ?? ""} className="field">
            <option value="">{t("filters.allStatuses")}</option>
            {RESERVATION_STATUSES.map((value) => (
              <option key={value} value={value}>
                {t(`status.${value}`)}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" className="btn-secondary px-3 py-2 text-small">
          {t("filters.submit")}
        </button>
      </Form>

      {list.reservations.length === 0 ? (
        <p className="rounded border border-border bg-surface px-4 py-6 text-center text-small text-muted">{t("empty")}</p>
      ) : (
        <div className="overflow-x-auto rounded border border-border bg-surface">
          <table className="w-full text-left text-small">
            <caption className="sr-only">{t("title")}</caption>
            <thead className="border-b border-border text-label text-muted">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">{t("fields.code")}</th>
                <th scope="col" className="px-3 py-2 font-medium">{t("fields.date")}</th>
                <th scope="col" className="px-3 py-2 font-medium">{t("fields.tour")}</th>
                <th scope="col" className="px-3 py-2 font-medium">{t("fields.customer")}</th>
                <th scope="col" className="px-3 py-2 font-medium">{t("fields.people")}</th>
                <th scope="col" className="px-3 py-2 font-medium">{t("fields.status")}</th>
                {showAmounts ? <th scope="col" className="px-3 py-2 text-right font-medium">{t("fields.amount")}</th> : null}
                {canWrite ? (
                  <th scope="col" className="px-3 py-2 font-medium">
                    <span className="sr-only">{t("fields.actions")}</span>
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {list.reservations.map((reservation) => (
                <tr key={reservation.id} className="border-b border-rule align-top last:border-b-0" data-reservation-code={reservation.code}>
                  <td className="whitespace-nowrap px-3 py-2 font-mono text-text">{reservation.code}</td>
                  <td className="whitespace-nowrap px-3 py-2">
                    <Link href={`/departures/${reservation.departureId}`} className="capitalize text-accent hover:underline">
                      {formatLocalDate(reservation.date, locale)}
                    </Link>
                    <span className="text-muted"> · {reservation.startTime}</span>
                  </td>
                  <td className="px-3 py-2">{reservation.tourName ?? t("none")}</td>
                  <td className="px-3 py-2">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-text">{reservation.customerName ?? t("none")}</span>
                      {reservation.hasIncompleteData ? (
                        <span className="badge-pending rounded-full px-2 py-0.5 text-label" title={t("incompleteHint")}>
                          {t("incomplete")}
                        </span>
                      ) : null}
                    </span>
                    {reservation.customerContact && (reservation.customerContact.email || reservation.customerContact.phone) ? (
                      <span className="block text-label text-muted">
                        {[reservation.customerContact.email, reservation.customerContact.phone].filter(Boolean).join(" · ")}
                      </span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2">{reservation.people}</td>
                  <td className="px-3 py-2">
                    <span className={`rounded-full px-2 py-0.5 text-label ${STATUS_BADGE[reservation.status]}`} data-status={reservation.status}>
                      {t(`status.${reservation.status}`)}
                    </span>
                    {reservation.cancelReason ? (
                      <span className="block pt-1 text-label text-muted">
                        {reservation.cancelReason === DEPARTURE_CANCELLED_REASON
                          ? t("cancelReason.departure_cancelled")
                          : reservation.cancelReason}
                      </span>
                    ) : null}
                  </td>
                  {showAmounts ? (
                    <td className="whitespace-nowrap px-3 py-2 text-right" data-amount>
                      {reservation.amount ? formatMinor(reservation.amount.totalMinor, reservation.amount.currency, locale) : t("none")}
                      {reservation.amount?.overridden ? <span className="block text-label text-muted">{t("overridden")}</span> : null}
                    </td>
                  ) : null}
                  {canWrite ? (
                    <td className="px-3 py-2">
                      {reservation.status !== "cancelled" ? (
                        <CancelReservationForm reservationId={reservation.id} code={reservation.code} />
                      ) : null}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {list.hasMore ? <p className="text-label text-muted">{t("hasMore", { count: RESERVATION_LIST_LIMIT })}</p> : null}
    </section>
  );
}
