import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { redirect } from "@/i18n/navigation";
import { pageLocale } from "@/i18n/params";
import { getOperatorContext, getSessionUser } from "@/lib/dal/context";
import { signOutAction } from "../../(app)/actions";

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("auth.noAccess");
  return { title: t("title") };
}

// R5: a signed-in user with no active membership. A user who regained one is
// sent back to the shell.
export default async function NoAccessPage({ params }: Props) {
  const locale = await pageLocale(params);
  const user = await getSessionUser();
  if (!user) return redirect({ href: "/login", locale });
  if (await getOperatorContext()) return redirect({ href: "/", locale });

  const t = await getTranslations("auth.noAccess");
  const shell = await getTranslations("shell");
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h1 className="text-subhead font-semibold text-text">{t("title")}</h1>
        <p className="text-small text-muted">{t("description")}</p>
        {user?.email ? <p className="text-label text-faint">{t("signedInAs", { email: user.email })}</p> : null}
      </div>
      <form action={signOutAction}>
        <input type="hidden" name="locale" value={locale} />
        <button type="submit" className="btn-secondary w-full text-small">
          {shell("signOut")}
        </button>
      </form>
    </div>
  );
}
