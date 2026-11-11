import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { SetPasswordForm } from "@/components/auth/set-password-form";
import { redirect } from "@/i18n/navigation";
import { pageLocale } from "@/i18n/params";
import { getSessionUser } from "@/lib/dal/context";

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("auth.setPassword");
  return { title: t("title") };
}

// Reached from invite and recovery links (/auth/confirm) and from the (app)
// layout when a staff context has no password yet (KTD8).
export default async function SetPasswordPage({ params }: Props) {
  const locale = await pageLocale(params);
  const user = await getSessionUser();
  if (!user) return redirect({ href: "/login", locale });

  const t = await getTranslations("auth.setPassword");
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h1 className="text-subhead font-semibold text-text">{t("title")}</h1>
        <p className="text-small text-muted">{t("description")}</p>
      </div>
      <SetPasswordForm locale={locale} email={user?.email ?? null} />
    </div>
  );
}
