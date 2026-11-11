import { addDays, isIsoDate, todayIn } from "@cupo/shared/local-date";
import { can } from "@cupo/shared/permissions";
import { DEPARTURE_STATUSES, type DepartureStatus } from "@cupo/shared/schemas/tours";
import { getTranslations } from "next-intl/server";
import Form from "next/form";
import { z } from "zod";
import { DepartureForm } from "@/components/forms/departure-form";
import { getPathname, Link } from "@/i18n/navigation";
import { pageLocale } from "@/i18n/params";
import { defaultDepartureWindow, DEPARTURE_LIST_LIMIT, listDepartures } from "@/lib/dal/departures";
import { listGuides } from "@/lib/dal/guides";
import { requirePageContext } from "@/lib/dal/page";
import { listTours } from "@/lib/dal/tours";
import { formatLocalDate } from "@/lib/format";

type Props = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

const STATUS_BADGE = { scheduled: "badge-confirmed", closed: "badge-pending", cancelled: "badge-cancelled" } as const;

function single(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

const uuid = z.uuid();

// Departures of the operator (U5, R16 to R18): a date-range list with tour
// and status filters, and the ad hoc departure form for administradores and
// reservas (only administradores pick a guide, KTD13).
export default async function DeparturesPage({ params, searchParams }: Props) {
  const locale = await pageLocale(params);
  const ctx = await requirePageContext(locale, "departures.read");
  const search = await searchParams;
  const today = todayIn(ctx.operator.timezone);
  const from = isIsoDate(single(search.from)) ? single(search.from) : defaultDepartureWindow(today).from;
  // A missing or inverted end shows two weeks from the start.
  const to = isIsoDate(single(search.to)) && single(search.to) >= from ? single(search.to) : addDays(from, 14);
  const tourId = uuid.safeParse(single(search.tour)).success ? single(search.tour) : undefined;
  const status = (DEPARTURE_STATUSES as readonly string[]).includes(single(search.status))
    ? (single(search.status) as DepartureStatus)
    : undefined;
  const canCreate = can(ctx.role, "departures.ad_hoc");
  const canAssignGuide = can(ctx.role, "departures.write");

  const [t, list, tours, guides] = await Promise.all([
    getTranslations("departures"),
    listDepartures(ctx, { from, to, tourId, status }),
    listTours(ctx, { includeArchived: true }),
    canAssignGuide ? listGuides(ctx) : Promise.resolve([]),
  ]);
  const activeTours = tours.filter((tour) => !tour.archived);

  return (
    <section className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-heading font-semibold tracking-tight text-text">{t("title")}</h1>
        <p className="text-small text-muted">{t("description", { timezone: ctx.operator.timezone })}</p>
      </header>

      {canCreate ? (
        <details className="rounded border border-border bg-surface p-4">
          <summary className="cursor-pointer text-small font-semibold text-text">{t("new")}</summary>
          <div className="flex flex-col gap-2 pt-3">
            <p className="text-label text-muted">{t("newDescription")}</p>
            {activeTours.length === 0 ? (
              <p className="text-small text-muted">{t("noTours")}</p>
            ) : (
              <DepartureForm
                mode="create"
                locale={locale}
                tours={activeTours.map((tour) => ({ id: tour.id, name: tour.name }))}
                guides={canAssignGuide ? guides.filter((guide) => guide.active).map((guide) => ({ id: guide.id, name: guide.name })) : undefined}
                initial={{ date: today, tourId: tourId ?? "" }}
              />
            )}
          </div>
        </details>
      ) : null}

      <Form action={getPathname({ href: "/departures", locale })} className="flex flex-wrap items-end gap-3" aria-label={t("filters.label")}>
        <div className="flex flex-col gap-1">
          <label htmlFor="filter-from" className="text-small font-medium text-text">{t("filters.from")}</label>
          <input id="filter-from" name="from" type="date" defaultValue={from} className="field" />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="filter-to" className="text-small font-medium text-text">{t("filters.to")}</label>
          <input id="filter-to" name="to" type="date" defaultValue={to} className="field" />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="filter-tour" className="text-small font-medium text-text">{t("filters.tour")}</label>
          <select id="filter-tour" name="tour" defaultValue={tourId ?? ""} className="field">
            <option value="">{t("filters.allTours")}</option>
            {tours.map((tour) => (
              <option key={tour.id} value={tour.id}>
                {tour.name}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="filter-status" className="text-small font-medium text-text">{t("filters.status")}</label>
          <select id="filter-status" name="status" defaultValue={status ?? ""} className="field">
            <option value="">{t("filters.allStatuses")}</option>
            {DEPARTURE_STATUSES.map((value) => (
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

      {list.departures.length === 0 ? (
        <p className="text-small text-muted">{t("empty")}</p>
      ) : (
        <div className="overflow-x-auto rounded border border-border bg-surface">
          <table className="w-full text-left text-small">
            <caption className="sr-only">{t("title")}</caption>
            <thead className="border-b border-border text-label text-muted">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">{t("fields.date")}</th>
                <th scope="col" className="px-3 py-2 font-medium">{t("fields.startTime")}</th>
                <th scope="col" className="px-3 py-2 font-medium">{t("fields.tour")}</th>
                <th scope="col" className="px-3 py-2 font-medium">{t("fields.status")}</th>
                <th scope="col" className="px-3 py-2 font-medium">{t("fields.seats")}</th>
                <th scope="col" className="px-3 py-2 font-medium">{t("fields.available")}</th>
                <th scope="col" className="px-3 py-2 font-medium">{t("fields.guide")}</th>
              </tr>
            </thead>
            <tbody>
              {list.departures.map((departure) => {
                const available = Math.max(0, departure.capacity - departure.seatsBooked);
                return (
                  <tr key={departure.id} className="border-b border-rule last:border-b-0" data-departure-id={departure.id}>
                    <td className="whitespace-nowrap px-3 py-2">
                      <Link href={`/departures/${departure.id}`} className="font-medium capitalize text-accent hover:underline">
                        {formatLocalDate(departure.date, locale)}
                      </Link>
                    </td>
                    <td className="px-3 py-2">{departure.startTime}</td>
                    <td className="px-3 py-2">{departure.tourName ?? t("none")}</td>
                    <td className="px-3 py-2">
                      <span className={`rounded-full px-2 py-0.5 text-label ${STATUS_BADGE[departure.status]}`}>{t(`status.${departure.status}`)}</span>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-muted">{t("seats", { booked: departure.seatsBooked, capacity: departure.capacity })}</td>
                    <td className="px-3 py-2">
                      {available === 0 && departure.status !== "cancelled" ? (
                        <span className="badge-full rounded-full px-2 py-0.5 text-label">{t("full")}</span>
                      ) : (
                        <span className="text-muted">{available}</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-muted">{departure.guideName ?? t("none")}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {list.hasMore ? <p className="text-label text-muted">{t("hasMore", { count: DEPARTURE_LIST_LIMIT })}</p> : null}
    </section>
  );
}
