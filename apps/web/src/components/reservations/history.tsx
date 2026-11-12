// Change history of a reservation (plan U10, R29), for administradores: one
// entry per change with its actor and time in the operator's zone, listing
// only the fields that changed. The entries come from lib/dal/audit.ts, which
// already resolved ids to labels; this component only formats them.
import { formatMinor } from "@cupo/shared/money";
import { DEPARTURE_CANCELLED_REASON } from "@cupo/shared/schemas/reservations";
import { getTranslations } from "next-intl/server";
import type { HistoryActor, HistoryEntry, HistoryValue } from "@/lib/dal/audit";
import { formatInstant, formatLocalDate } from "@/lib/format";

type Props = { entries: readonly HistoryEntry[]; locale: string; timeZone: string };

export async function ReservationHistory({ entries, locale, timeZone }: Props) {
  const [t, tr, tt] = await Promise.all([getTranslations("history"), getTranslations("reservations"), getTranslations("tours")]);

  const actorName = (actor: HistoryActor) => (actor.kind === "user" ? actor.name : t(`actor.${actor.kind}`));
  const fieldName = (field: string) => (t.has(`fields.${field}`) ? t(`fields.${field}`) : field);
  const valueText = (field: string, value: HistoryValue): string => {
    switch (value.kind) {
      case "empty":
        return t("values.empty");
      case "boolean":
        return value.value ? t("values.yes") : t("values.no");
      case "number":
        return String(value.value);
      case "status":
        return tr.has(`status.${value.value}`) ? tr(`status.${value.value}`) : value.value;
      case "reason":
        return value.value === DEPARTURE_CANCELLED_REASON ? tr("cancelReason.departure_cancelled") : value.value;
      case "money":
        return formatMinor(value.minor, value.currency, locale);
      case "departure":
        return value.label
          ? t("values.departure", {
              tour: value.label.tourName ?? t("values.unknownTour"),
              date: formatLocalDate(value.label.date, locale),
              time: value.label.startTime,
            })
          : t("values.unknownDeparture");
      case "customer":
        return value.name ?? t("values.unknownCustomer");
      case "text":
        return field === "channel" && tt.has(`channels.${value.value}`) ? tt(`channels.${value.value}`) : value.value;
    }
  };

  if (entries.length === 0) return <p className="text-small text-muted">{t("empty")}</p>;

  return (
    <ol className="flex flex-col gap-3">
      {entries.map((entry) => {
        const created = entry.action === "created";
        return (
          <li key={entry.id} className="flex flex-col gap-2 rounded border border-rule p-3" data-history-action={entry.action}>
            <p className="flex flex-wrap items-baseline gap-x-2 text-small">
              <span className="font-medium text-text">{t(`action.${entry.action}`)}</span>
              <span className="text-muted" data-history-actor={entry.actor.kind}>
                {actorName(entry.actor)}
              </span>
              <time dateTime={entry.at} className="text-muted">
                {formatInstant(entry.at, locale, timeZone)}
              </time>
            </p>
            <table className="w-full text-left text-label">
              <thead className="sr-only">
                <tr>
                  <th scope="col">{t("columns.field")}</th>
                  {created ? null : <th scope="col">{t("columns.before")}</th>}
                  <th scope="col">{t("columns.after")}</th>
                </tr>
              </thead>
              <tbody>
                {entry.changes.map((change) => (
                  <tr key={`${change.subject}.${change.field}`} data-history-field={change.field}>
                    <th scope="row" className="w-48 py-0.5 pr-3 align-top font-normal text-muted">
                      {fieldName(change.field)}
                    </th>
                    {created ? null : (
                      <td className="py-0.5 pr-3 align-top text-muted line-through decoration-faint">{valueText(change.field, change.before)}</td>
                    )}
                    <td className="py-0.5 align-top text-text">{valueText(change.field, change.after)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </li>
        );
      })}
    </ol>
  );
}
