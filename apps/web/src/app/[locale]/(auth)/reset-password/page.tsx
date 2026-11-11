import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { ResetPasswordForm } from "@/components/auth/reset-password-form";
import { Link } from "@/i18n/navigation";
import { pageLocale } from "@/i18n/params";

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("auth.resetPassword");
  return { title: t("title") };
}

export default async function ResetPasswordPage({ params }: Props) {
  await pageLocale(params);
  const t = await getTranslations("auth.resetPassword");
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h1 className="text-subhead font-semibold text-text">{t("title")}</h1>
        <p className="text-small text-muted">{t("description")}</p>
      </div>
      <ResetPasswordForm />
      <Link href="/login" className="text-small text-accent hover:underline">
        {t("backToLogin")}
      </Link>
    </div>
  );
}
