"use client";

import { Link, usePathname } from "@/i18n/navigation";

// Client only for the active state: layouts do not re-render on navigation,
// so the server cannot keep aria-current up to date.
export function NavLink({ href, label }: { href: string; label: string }) {
  const pathname = usePathname();
  const active = pathname === href || pathname.startsWith(`${href}/`);
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={
        active
          ? "block rounded bg-accent-soft px-3 py-1.5 text-small font-semibold text-accent-ink"
          : "block rounded px-3 py-1.5 text-small text-muted hover:bg-raised hover:text-text"
      }
    >
      {label}
    </Link>
  );
}
