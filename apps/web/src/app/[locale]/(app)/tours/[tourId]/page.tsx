import { isIsoDate, todayIn } from "@cupo/shared/local-date";
import { formatMinor, minorToInput } from "@cupo/shared/money";
import { can } from "@cupo/shared/permissions";
import { CHANNELS, tourIdSchema } from "@cupo/shared/schemas/tours";
import { getTranslations } from "next-intl/server";
import Form from "next/form";
import { notFound } from "next/navigation";
import { createDepartureAction } from "@/app/[locale]/(app)/departures/actions";
import { ActionButton } from "@/components/forms/action-button";
import { PriceForm } from "@/components/forms/price-form";
import { ScheduleForm } from "@/components/forms/schedule-form";
import { TourForm } from "@/components/forms/tour-form";
import { getPathname, Link } from "@/i18n/navigation";
import { pageLocale } from "@/i18n/params";
import { defaultDepartureWindow, listDepartures, listDepartureSlots } from "@/lib/dal/departures";
import { requirePageContext } from "@/lib/dal/page";
import { canReadPrices, getTour, listSchedules, listTourPrices, type TourPrice } from "@/lib/dal/tours";
import { formatLocalDate, weekdayName } from "@/lib/format";
import { deleteScheduleAction, setTourArchivedAction } from "../actions";

type Props = {
  params: Promise<{ locale: string; tourId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

const STATUS_BADGE = { scheduled: "badge-confirmed", closed: "badge-pending", cancelled: "badge-cancelled" } as const;

// One tour (U5, R15 to R17, R21): details, channel prices (administrador and
// contabilidad read them, administradores set them), weekly schedules, the
// slots of a chosen date and the next departures.
export default async function TourPage({ params, searchParams }: Props) {
  const locale = await pageLocale(params);
  const ctx = await requirePageContext(locale, "tours.read");
  const { tourId } = await params;
  if (!tourIdSchema.safeParse({ tourId }).success) notFound();
  const tour = await getTour(ctx, tourId);
  if (!tour) notFound();

  const today = todayIn(ctx.operator.timezone);
  const dateParam = (await searchParams).date;
  const slotDate = typeof dateParam === "string" && isIsoDate(dateParam) ? dateParam : today;
  const canWrite = can(ctx.role, "tours.write");
  const canSetPrices = can(ctx.role, "amounts.write");
  const showPrices = canReadPrices(ctx);
  const canCreateDeparture = can(ctx.role, "departures.ad_hoc") && !tour.archived;

  const [t, td, schedules, prices, slots, upcoming] = await Promise.all([
    getTranslations("tours"),
    getTranslations("departures"),
    listSchedules(ctx, tour.id),
    showPrices ? listTourPrices(ctx, [tour.id]) : Promise.resolve(new Map<string, TourPrice[]>()),
    listDepartureSlots(ctx, tour.id, slotDate),
    listDepartures(ctx, { ...defaultDepartureWindow(today), tourId: tour.id }),
  ]);
  const priceByChannel = new Map((prices.get(tour.id) ?? []).map((price) => [price.channel, price]));
  const currencies = [...new Set([ctx.operator.currency, "USD", "EUR"])];

  const details: Array<[string, string]> = [
    [t("fields.description"), tour.description ?? t("none")],
    [t("fields.duration"), t("minutes", { count: tour.durationMinutes })],
    [t("fields.defaultCapacity"), String(tour.defaultCapacity)],
    [t("fields.meetingPoint"), tour.meetingPoint ?? t("none")],
  ];

  return (
    <section className="flex flex-col gap-6">
      <Link href="/tours" className="text-small text-accent hover:underline">
        {t("back")}
      </Link>
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-heading font-semibold tracking-tight text-text">{tour.name}</h1>
        <span className={`rounded-full px-2 py-0.5 text-label ${tour.archived ? "badge-cancelled" : "badge-confirmed"}`}>
          {tour.archived ? t("status.archived") : t("status.active")}
        </span>
      </header>
      {tour.archived ? <p className="text-small text-warning">{t("archivedNotice")}</p> : null}

      <div className="flex flex-col gap-3 rounded border border-border bg-surface p-4">
        <h2 className="text-small font-semibold text-text">{t("edit")}</h2>
        {canWrite ? (
          <TourForm
            key={tour.id}
            mode="edit"
            locale={locale}
            tourId={tour.id}
            initial={{
              name: tour.name,
              description: tour.description ?? "",
              durationMinutes: String(tour.durationMinutes),
              defaultCapacity: String(tour.defaultCapacity),
              meetingPoint: tour.meetingPoint ?? "",
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

      {showPrices ? (
        <div className="flex flex-col gap-3 rounded border border-border bg-surface p-4" data-section="prices">
          <div className="flex flex-col gap-1">
            <h2 className="text-small font-semibold text-text">{t("prices.title")}</h2>
            <p className="text-label text-muted">{t("prices.description")}</p>
          </div>
          <ul className="flex flex-col divide-y divide-rule">
            {CHANNELS.map((channel) => {
              const price = priceByChannel.get(channel);
              return (
                <li key={channel} className="flex flex-col gap-2 py-2 sm:flex-row sm:items-end sm:justify-between" data-channel={channel}>
                  <div className="flex flex-col">
                    <span className="text-small font-medium text-text">
                      {t(`channels.${channel}`)}
                      {channel === "direct" ? <span className="ml-2 text-label text-muted">{t("prices.required")}</span> : null}
                    </span>
                    <span className="text-small text-muted" data-price>
                      {price ? formatMinor(price.priceMinor, price.currency, locale) : t("prices.missing")}
                    </span>
                  </div>
                  {canSetPrices ? (
                    <PriceForm
                      tourId={tour.id}
                      channel={channel}
                      channelLabel={t(`channels.${channel}`)}
                      currencies={price && !currencies.includes(price.currency) ? [...currencies, price.currency] : currencies}
                      initial={price ? { amount: minorToInput(price.priceMinor, price.currency), currency: price.currency } : undefined}
                    />
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      <div className="flex flex-col gap-3 rounded border border-border bg-surface p-4" data-section="schedules">
        <div className="flex flex-col gap-1">
          <h2 className="text-small font-semibold text-text">{t("schedules.title")}</h2>
          <p className="text-label text-muted">{t("schedules.description", { timezone: ctx.operator.timezone })}</p>
        </div>
        {schedules.length === 0 ? (
          <p className="text-small text-muted">{t("schedules.empty")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-small">
              <caption className="sr-only">{t("schedules.title")}</caption>
              <thead className="border-b border-border text-label text-muted">
                <tr>
                  <th scope="col" className="px-2 py-2 font-medium">{t("schedules.weekday")}</th>
                  <th scope="col" className="px-2 py-2 font-medium">{t("schedules.startTime")}</th>
                  <th scope="col" className="px-2 py-2 font-medium">{t("schedules.capacity")}</th>
                  <th scope="col" className="px-2 py-2 font-medium">{t("schedules.validity")}</th>
                  {canWrite ? <th scope="col" className="px-2 py-2 font-medium"><span className="sr-only">{t("schedules.actions")}</span></th> : null}
                </tr>
              </thead>
              <tbody>
                {schedules.map((schedule) => (
                  <tr key={schedule.id} className="border-b border-rule last:border-b-0" data-schedule-id={schedule.id}>
                    <td className="px-2 py-2 capitalize">{weekdayName(schedule.weekday, locale)}</td>
                    <td className="px-2 py-2">{schedule.startTime}</td>
                    <td className="px-2 py-2 text-muted">
                      {schedule.capacityOverride ?? t("schedules.defaultCapacity", { count: tour.defaultCapacity })}
                    </td>
                    <td className="px-2 py-2 text-muted">
                      {schedule.validTo
                        ? t("schedules.range", { from: formatLocalDate(schedule.validFrom, locale), to: formatLocalDate(schedule.validTo, locale) })
                        : t("schedules.openEnded", { from: formatLocalDate(schedule.validFrom, locale) })}
                    </td>
                    {canWrite ? (
                      <td className="px-2 py-2 text-right">
                        <ActionButton
                          action={deleteScheduleAction}
                          fields={{ scheduleId: schedule.id }}
                          label={t("schedules.remove")}
                          confirmMessage={t("schedules.removeConfirm")}
                          tone="danger"
                        />
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {canWrite ? (
          <details className="rounded border border-border p-3">
            <summary className="cursor-pointer text-small font-semibold text-text">{t("schedules.add")}</summary>
            <div className="pt-3">
              <ScheduleForm tourId={tour.id} today={today} />
            </div>
          </details>
        ) : null}
      </div>

      <div className="flex flex-col gap-3 rounded border border-border bg-surface p-4" data-section="slots">
        <div className="flex flex-col gap-1">
          <h2 className="text-small font-semibold text-text">{t("slots.title")}</h2>
          <p className="text-label text-muted">{t("slots.description")}</p>
        </div>
        <Form action={getPathname({ href: `/tours/${tour.id}`, locale })} className="flex flex-wrap items-end gap-2">
          <div className="flex flex-col gap-1">
            <label htmlFor="slot-date" className="text-small font-medium text-text">
              {t("slots.date")}
            </label>
            <input id="slot-date" name="date" type="date" defaultValue={slotDate} className="field" />
          </div>
          <button type="submit" className="btn-secondary px-3 py-2 text-small">
            {t("slots.show")}
          </button>
        </Form>
        <p className="text-small font-medium capitalize text-text">{formatLocalDate(slotDate, locale)}</p>
        {!slots || slots.length === 0 ? (
          <p className="text-small text-muted">{t("slots.empty")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-small">
              <caption className="sr-only">{t("slots.title")}</caption>
              <thead className="border-b border-border text-label text-muted">
                <tr>
                  <th scope="col" className="px-2 py-2 font-medium">{td("fields.startTime")}</th>
                  <th scope="col" className="px-2 py-2 font-medium">{td("fields.origin")}</th>
                  <th scope="col" className="px-2 py-2 font-medium">{td("fields.status")}</th>
                  <th scope="col" className="px-2 py-2 font-medium">{td("fields.capacity")}</th>
                  <th scope="col" className="px-2 py-2 font-medium">{td("fields.available")}</th>
                  <th scope="col" className="px-2 py-2 font-medium"><span className="sr-only">{t("schedules.actions")}</span></th>
                </tr>
              </thead>
              <tbody>
                {slots.map((slot) => (
                  <tr key={slot.startTime} className="border-b border-rule last:border-b-0" data-slot={slot.startTime}>
                    <td className="px-2 py-2 font-medium">{slot.startTime}</td>
                    <td className="px-2 py-2 text-muted">{td(`origin.${slot.origin}`)}</td>
                    <td className="px-2 py-2">
                      {slot.status ? (
                        <span className={`rounded-full px-2 py-0.5 text-label ${STATUS_BADGE[slot.status]}`}>{td(`status.${slot.status}`)}</span>
                      ) : (
                        <span className="text-muted">{t("slots.notCreated")}</span>
                      )}
                    </td>
                    <td className="px-2 py-2 text-muted">{slot.capacity}</td>
                    <td className="px-2 py-2 text-muted">{slot.available}</td>
                    <td className="px-2 py-2 text-right">
                      {slot.departureId ? (
                        <Link href={`/departures/${slot.departureId}`} className="text-accent hover:underline">
                          {t("slots.open")}
                        </Link>
                      ) : canCreateDeparture ? (
                        <ActionButton
                          action={createDepartureAction}
                          fields={{
                            locale,
                            tourId: tour.id,
                            date: slotDate,
                            startTime: slot.startTime,
                            capacity: String(slot.capacity),
                            guideId: "",
                          }}
                          label={t("slots.create")}
                        />
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-3 rounded border border-border bg-surface p-4" data-section="upcoming">
        <h2 className="text-small font-semibold text-text">{t("upcoming.title")}</h2>
        {upcoming.departures.length === 0 ? (
          <p className="text-small text-muted">{t("upcoming.empty")}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-rule text-small">
            {upcoming.departures.map((departure) => (
              <li key={departure.id} className="flex flex-wrap items-center gap-3 py-2">
                <Link href={`/departures/${departure.id}`} className="font-medium text-accent hover:underline">
                  {formatLocalDate(departure.date, locale)} · {departure.startTime}
                </Link>
                <span className={`rounded-full px-2 py-0.5 text-label ${STATUS_BADGE[departure.status]}`}>{td(`status.${departure.status}`)}</span>
                <span className="text-muted">{td("seats", { booked: departure.seatsBooked, capacity: departure.capacity })}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {canWrite ? (
        <div className="flex flex-col gap-2 rounded border border-border bg-surface p-4">
          <h2 className="text-small font-semibold text-text">{t("archive.title")}</h2>
          <p className="text-small text-muted">{tour.archived ? t("archive.archivedDescription") : t("archive.activeDescription")}</p>
          <div>
            {tour.archived ? (
              <ActionButton action={setTourArchivedAction} fields={{ tourId: tour.id, archived: "false" }} label={t("archive.restore")} />
            ) : (
              <ActionButton
                action={setTourArchivedAction}
                fields={{ tourId: tour.id, archived: "true" }}
                label={t("archive.archive")}
                confirmMessage={t("archive.confirm", { name: tour.name })}
                tone="danger"
              />
            )}
          </div>
        </div>
      ) : null}
    </section>
  );
}
