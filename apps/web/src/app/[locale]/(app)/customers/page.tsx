import { can } from "@cupo/shared/permissions";
import { customerSearchSchema } from "@cupo/shared/schemas/customers";
import { getTranslations } from "next-intl/server";
import Form from "next/form";
import { notFound } from "next/navigation";
import { z } from "zod";
import { CustomerForm } from "@/components/forms/customer-form";
import { getPathname, Link } from "@/i18n/navigation";
import { pageLocale } from "@/i18n/params";
import { getCustomer, listCustomers, CUSTOMER_LIST_LIMIT, type CustomerFull } from "@/lib/dal/customers";
import { NotFoundError } from "@/lib/dal/errors";
import { requirePageContext } from "@/lib/dal/page";

type Props = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

const editIdSchema = z.uuid();

// Customers (plan U9, R11, R26). Administrador and reservas see and edit full
// contact data; contabilidad sees masked names only (the DAL reads
// customer_display for them, and RLS returns no customers rows anyway).
export default async function CustomersPage({ params, searchParams }: Props) {
  const locale = await pageLocale(params);
  const ctx = await requirePageContext(locale, "customers.read");
  const search = await searchParams;
  const query = customerSearchSchema.parse({ q: single(search.q) }).q;
  const editParam = editIdSchema.safeParse(single(search.edit));
  const canWrite = can(ctx.role, "customers.write");

  let editing: CustomerFull | undefined;
  if (canWrite && editParam.success) {
    try {
      editing = await getCustomer(ctx, editParam.data);
    } catch (error) {
      if (error instanceof NotFoundError) notFound();
      throw error;
    }
  }

  const list = await listCustomers(ctx, { query });
  const t = await getTranslations("customers");
  const customersPath = getPathname({ href: "/customers", locale });

  return (
    <section className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-heading font-semibold tracking-tight text-text">{t("title")}</h1>
        <p className="text-small text-muted">
          {list.access === "full" ? t("descriptionFull", { operator: ctx.operator.name }) : t("descriptionMasked")}
        </p>
      </header>

      {canWrite ? (
        editing ? (
          <CustomerForm
            key={editing.id}
            mode="edit"
            locale={locale}
            customer={{
              id: editing.id,
              name: editing.name,
              email: editing.email,
              phone: editing.phone,
              preferredLocale: editing.preferredLocale,
            }}
          />
        ) : (
          <CustomerForm mode="create" locale={locale} />
        )
      ) : null}

      <Form action={customersPath} role="search" className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="flex flex-1 flex-col gap-1">
          <label htmlFor="customer-search" className="text-small font-medium text-text">
            {t("search.label")}
          </label>
          <input
            id="customer-search"
            name="q"
            type="search"
            defaultValue={query}
            maxLength={100}
            placeholder={list.access === "full" ? t("search.placeholderFull") : t("search.placeholderMasked")}
            className="field"
          />
        </div>
        <div className="flex gap-2">
          <button type="submit" className="btn-secondary text-small">
            {t("search.submit")}
          </button>
          {query ? (
            <Link href="/customers" className="btn-secondary text-small">
              {t("search.clear")}
            </Link>
          ) : null}
        </div>
      </Form>

      {list.customers.length === 0 ? (
        <p className="rounded border border-border bg-surface px-4 py-6 text-center text-small text-muted">
          {query ? t("list.noResults", { query }) : t("list.empty")}
        </p>
      ) : (
        <div className="overflow-x-auto rounded border border-border bg-surface">
          <table className="w-full text-left text-small">
            <caption className="sr-only">{t("list.caption", { operator: ctx.operator.name })}</caption>
            <thead className="border-b border-border text-label text-muted">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">
                  {t("list.name")}
                </th>
                {list.access === "full" ? (
                  <>
                    <th scope="col" className="px-3 py-2 font-medium">
                      {t("list.email")}
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      {t("list.phone")}
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      {t("list.locale")}
                    </th>
                    {canWrite ? (
                      <th scope="col" className="px-3 py-2 font-medium">
                        <span className="sr-only">{t("list.actions")}</span>
                      </th>
                    ) : null}
                  </>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {list.access === "full"
                ? list.customers.map((customer) => (
                    <tr key={customer.id} className="border-b border-rule last:border-b-0">
                      <td className="px-3 py-2 font-medium text-text">
                        <span className="flex flex-wrap items-center gap-2">
                          {customer.name}
                          {!customer.email && !customer.phone ? (
                            <span className="badge-pending rounded-full px-2 py-0.5 text-label">{t("list.noContact")}</span>
                          ) : null}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-text">
                        {customer.email ?? <span className="text-faint">{t("list.noValue")}</span>}
                      </td>
                      <td className="px-3 py-2 text-text">
                        {customer.phone ?? <span className="text-faint">{t("list.noValue")}</span>}
                      </td>
                      <td className="px-3 py-2 text-muted">
                        {customer.preferredLocale ? t(`locales.${customer.preferredLocale}`) : t("locales.operatorDefault")}
                      </td>
                      {canWrite ? (
                        <td className="px-3 py-2 text-right">
                          <Link
                            href={{ pathname: "/customers", query: { edit: customer.id } }}
                            aria-label={t("list.editLabel", { name: customer.name })}
                            className="text-small font-medium text-accent-ink hover:underline"
                          >
                            {t("list.edit")}
                          </Link>
                        </td>
                      ) : null}
                    </tr>
                  ))
                : list.customers.map((customer) => (
                    <tr key={customer.id} className="border-b border-rule last:border-b-0">
                      <td className="px-3 py-2 text-text">{customer.displayName}</td>
                    </tr>
                  ))}
            </tbody>
          </table>
        </div>
      )}

      {list.hasMore ? <p className="text-label text-muted">{t("list.hasMore", { count: CUSTOMER_LIST_LIMIT })}</p> : null}
    </section>
  );
}
