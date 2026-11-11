import { formatMinor } from "@cupo/shared/money";
import { can } from "@cupo/shared/permissions";
import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { pageLocale } from "@/i18n/params";
import { requirePageContext } from "@/lib/dal/page";
import { canReadPrices, listTourPrices, listTours, type TourPrice } from "@/lib/dal/tours";

type Props = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

// Tours of the operator (U5, R15, R21). Staff read them; administradores add
// and edit; the direct price column shows only for the roles that read prices.
export default async function ToursPage({ params, searchParams }: Props) {
  const locale = await pageLocale(params);
  const ctx = await requirePageContext(locale, "tours.read");
  const includeArchived = (await searchParams).archived === "1";
  const showPrices = canReadPrices(ctx);
  const [t, tours] = await Promise.all([getTranslations("tours"), listTours(ctx, { includeArchived })]);
  const prices = showPrices
    ? await listTourPrices(ctx, tours.map((tour) => tour.id))
    : new Map<string, TourPrice[]>();

  return (
    <section className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-heading font-semibold tracking-tight text-text">{t("title")}</h1>
          <p className="text-small text-muted">{t("description")}</p>
        </div>
        {can(ctx.role, "tours.write") ? (
          <Link href="/tours/new" className="btn-primary text-small">
            {t("new")}
          </Link>
        ) : null}
      </header>

      <p className="text-small">
        <Link href={includeArchived ? "/tours" : "/tours?archived=1"} className="text-accent hover:underline">
          {includeArchived ? t("hideArchived") : t("showArchived")}
        </Link>
      </p>

      {tours.length === 0 ? (
        <p className="text-small text-muted">{t("empty")}</p>
      ) : (
        <div className="overflow-x-auto rounded border border-border bg-surface">
          <table className="w-full text-left text-small">
            <caption className="sr-only">{t("title")}</caption>
            <thead className="border-b border-border text-label text-muted">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">{t("fields.name")}</th>
                <th scope="col" className="px-3 py-2 font-medium">{t("fields.duration")}</th>
                <th scope="col" className="px-3 py-2 font-medium">{t("fields.defaultCapacity")}</th>
                {showPrices ? <th scope="col" className="px-3 py-2 font-medium">{t("fields.directPrice")}</th> : null}
                <th scope="col" className="px-3 py-2 font-medium">{t("fields.status")}</th>
              </tr>
            </thead>
            <tbody>
              {tours.map((tour) => {
                const direct = prices.get(tour.id)?.find((price) => price.channel === "direct");
                return (
                  <tr key={tour.id} className="border-b border-rule last:border-b-0" data-tour-id={tour.id}>
                    <td className="px-3 py-2">
                      <Link href={`/tours/${tour.id}`} className="font-medium text-accent hover:underline">
                        {tour.name}
                      </Link>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-muted">{t("minutes", { count: tour.durationMinutes })}</td>
                    <td className="px-3 py-2 text-muted">{tour.defaultCapacity}</td>
                    {showPrices ? (
                      <td className="whitespace-nowrap px-3 py-2 text-muted" data-price>
                        {direct ? formatMinor(direct.priceMinor, direct.currency, locale) : t("prices.missing")}
                      </td>
                    ) : null}
                    <td className="px-3 py-2">
                      <span className={`rounded-full px-2 py-0.5 text-label ${tour.archived ? "badge-cancelled" : "badge-confirmed"}`}>
                        {tour.archived ? t("status.archived") : t("status.active")}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
