import { getTranslations } from "next-intl/server";
import { Header } from "@/components/layout/header";
import { Nav } from "@/components/layout/nav";
import { redirect } from "@/i18n/navigation";
import { pageLocale } from "@/i18n/params";
import { getOperatorContext, getSessionUser, shellGate } from "@/lib/dal/context";

type Props = { children: React.ReactNode; params: Promise<{ locale: string }> };

// App shell (KTD3). The redirects here are UX only: layouts do not re-run on
// every navigation, so every page and server action calls
// requireOperatorContext itself. No context goes to no-access (R5); a staff
// context without a password goes to set-password (R13); a guía never does.
export default async function AppLayout({ children, params }: Props) {
  const locale = await pageLocale(params);
  const user = await getSessionUser();
  if (!user) return redirect({ href: "/login", locale });

  const ctx = await getOperatorContext();
  const gate = shellGate(ctx);
  if (gate || !ctx) return redirect({ href: `/${gate ?? "no-access"}`, locale });

  const t = await getTranslations("shell");
  return (
    <div className="flex flex-1 flex-col">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-2 focus:rounded focus:bg-surface focus:px-3 focus:py-1.5"
      >
        {t("skipToContent")}
      </a>
      <Header ctx={ctx} locale={locale} />
      <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 px-4 py-6 md:flex-row">
        <Nav role={ctx.role} />
        <main id="main" className="min-w-0 flex-1">
          {children}
        </main>
      </div>
    </div>
  );
}
