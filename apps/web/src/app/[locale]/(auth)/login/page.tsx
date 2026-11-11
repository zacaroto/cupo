import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { LoginForm } from "@/components/auth/login-form";
import { Link, redirect } from "@/i18n/navigation";
import { pageLocale } from "@/i18n/params";
import { getSessionUser } from "@/lib/dal/context";

type Props = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ error?: string | string[] }>;
};

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("auth.login");
  return { title: t("title") };
}

export default async function LoginPage({ params, searchParams }: Props) {
  const locale = await pageLocale(params);
  // Already signed in: the shell decides between home, set-password and no-access.
  if (await getSessionUser()) return redirect({ href: "/", locale });

  const { error } = await searchParams;
  const t = await getTranslations("auth");

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h1 className="text-subhead font-semibold text-text">{t("login.title")}</h1>
        <p className="text-small text-muted">{t("login.description")}</p>
      </div>
      <LoginForm locale={locale} linkInvalid={error === "link_invalid"} />
      <Link href="/reset-password" className="text-small text-accent hover:underline">
        {t("login.forgotPassword")}
      </Link>
    </div>
  );
}
