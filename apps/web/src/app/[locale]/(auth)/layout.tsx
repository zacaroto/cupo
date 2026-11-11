import { getTranslations } from "next-intl/server";

// Centered single-card layout for the sign-in, password and no-access pages.
export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  const t = await getTranslations("common");
  return (
    <main className="flex flex-1 items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <p className="mb-6 text-center text-subhead font-semibold tracking-tight text-text">{t("appName")}</p>
        <div className="rounded border border-border bg-surface p-6">{children}</div>
      </div>
    </main>
  );
}
