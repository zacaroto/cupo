import { getTranslations } from "next-intl/server";
import { signOutAction } from "@/app/[locale]/(app)/actions";
import { Link } from "@/i18n/navigation";
import type { OperatorContext } from "@/lib/dal/context";
import { OperatorSwitcher } from "./operator-switcher";

// The operator name is on every page of the shell (R14).
export async function Header({ ctx, locale }: { ctx: OperatorContext; locale: string }) {
  const t = await getTranslations("shell");
  const common = await getTranslations("common");
  const options = ctx.memberships.map((m) => ({
    operatorId: m.operatorId,
    label: `${m.operatorName} · ${common(`roles.${m.role}`)}`,
  }));

  return (
    <header className="border-b border-border bg-surface">
      <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-2">
        <Link href="/" className="text-body font-semibold tracking-tight text-text">
          {common("appName")}
        </Link>
        <div className="flex items-baseline gap-2">
          <span className="text-label text-muted">{t("operator")}</span>
          <span className="text-small font-semibold text-text" data-operator-name>
            {ctx.operator.name}
          </span>
          <span className="rounded-full bg-raised px-2 py-0.5 text-label text-muted" data-role={ctx.role}>
            {common(`roles.${ctx.role}`)}
          </span>
        </div>
        {ctx.memberships.length >= 2 ? (
          <OperatorSwitcher locale={locale} activeOperatorId={ctx.operator.id} options={options} />
        ) : null}
        <div className="ml-auto flex items-center gap-3">
          {ctx.user.email ? <span className="text-label text-muted">{ctx.user.email}</span> : null}
          <form action={signOutAction}>
            <input type="hidden" name="locale" value={locale} />
            <button type="submit" className="btn-secondary px-3 py-1.5 text-small">
              {t("signOut")}
            </button>
          </form>
        </div>
      </div>
    </header>
  );
}
