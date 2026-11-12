import { isIsoDate, todayIn } from "@cupo/shared/local-date";
import { slotValue } from "@cupo/shared/schemas/reservations";
import { getTranslations } from "next-intl/server";
import Form from "next/form";
import { z } from "zod";
import { ReservationForm } from "@/components/forms/reservation-form";
import { getPathname, Link } from "@/i18n/navigation";
import { pageLocale } from "@/i18n/params";
import { listDepartureSlots } from "@/lib/dal/departures";
import { requirePageContext } from "@/lib/dal/page";
import { listTours } from "@/lib/dal/tours";

type Props = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

function single(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

const uuid = z.uuid();

// New reservation (U6, F3) for administrador and reservas: tour and date
// first (a GET form, so the slots are read on the server), then the booking
// form with that day's slots (existing departures and schedule times not
// materialized yet), people, status, customer and notes.
export default async function NewReservationPage({ params, searchParams }: Props) {
  const locale = await pageLocale(params);
  const ctx = await requirePageContext(locale, "reservations.write");
  const search = await searchParams;
  const today = todayIn(ctx.operator.timezone);
  const tourParam = uuid.safeParse(single(search.tour)).success ? single(search.tour) : "";
  const date = isIsoDate(single(search.date)) ? single(search.date) : today;

  const [t, tours] = await Promise.all([getTranslations("reservations"), listTours(ctx)]);
  const tour = tours.find((candidate) => candidate.id === tourParam);
  const slots = tour ? await listDepartureSlots(ctx, tour.id, date) : null;

  return (
    <section className="flex flex-col gap-6">
      <Link href="/reservations" className="text-small text-accent hover:underline">
        {t("newPage.back")}
      </Link>
      <header className="flex flex-col gap-1">
        <h1 className="text-heading font-semibold tracking-tight text-text">{t("newPage.title")}</h1>
        <p className="text-small text-muted">{t("newPage.description")}</p>
      </header>

      {tours.length === 0 ? (
        <p className="text-small text-muted">{t("newPage.noTours")}</p>
      ) : (
        <Form action={getPathname({ href: "/reservations/new", locale })} className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <label htmlFor="new-reservation-tour" className="text-small font-medium text-text">{t("newPage.tour")}</label>
            <select id="new-reservation-tour" name="tour" defaultValue={tour?.id ?? ""} required className="field">
              <option value="">{t("newPage.chooseTour")}</option>
              {tours.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="new-reservation-date" className="text-small font-medium text-text">{t("newPage.date")}</label>
            <input id="new-reservation-date" name="date" type="date" defaultValue={date} required className="field" />
          </div>
          <button type="submit" className="btn-secondary px-3 py-2 text-small">
            {t("newPage.showSlots")}
          </button>
        </Form>
      )}

      {tourParam && !tour ? <p className="text-small text-negative">{t("newPage.unknownTour")}</p> : null}
      {tour && slots !== null && slots.length === 0 ? <p className="text-small text-muted">{t("newPage.noSlots")}</p> : null}
      {tour && slots !== null && slots.length > 0 ? (
        <ReservationForm
          key={`${tour.id}:${date}`}
          locale={locale}
          tourId={tour.id}
          date={date}
          slots={slots.map((slot) => ({
            value: slotValue(slot),
            startTime: slot.startTime,
            available: slot.available,
            closed: slot.status === "closed",
          }))}
        />
      ) : null}
    </section>
  );
}
