import { SectionPlaceholder } from "@/components/layout/section-placeholder";
import { pageLocale } from "@/i18n/params";
import { requirePageContext } from "@/lib/dal/page";

type Props = { params: Promise<{ locale: string }> };

// Placeholder until U6 ships this section; the permission check is final.
export default async function ReservationsPage({ params }: Props) {
  const locale = await pageLocale(params);
  await requirePageContext(locale, "reservations.read");
  return <SectionPlaceholder section="reservations" />;
}
