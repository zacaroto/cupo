// Customers DAL (plan U9, R11, R26, KTD3, KTD4). Every function takes the
// operator context as its first parameter and never resolves it itself; the
// page or server action calls `requireOperatorContext` first.
//
// Two read paths, chosen by role and enforced again by RLS:
// - full (`customers.read_full`, administrador and reservas): `customers`.
// - masked (every other role): `customer_display` only. Screens that list
//   reservations for these roles fetch the reservations first and then call
//   `getCustomerDisplays` with their customer ids (KTD4 two-query pattern).
//
// Customer data is personal data: nothing here logs names, emails, phones or
// search terms.
import "server-only";
import type { CustomerInput, CustomerLocale } from "@cupo/shared/schemas/customers";
import { can } from "@cupo/shared/permissions";
import { createClient } from "@/lib/supabase/server";
import type { OperatorContext } from "./context";
import { customerSearchFilter, likeContains } from "./customer-search";
import { ForbiddenError, NotFoundError } from "./errors";

/** Rows per page of the list and the reservation customer picker. */
export const CUSTOMER_LIST_LIMIT = 50;

export type CustomerFull = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  preferredLocale: CustomerLocale | null;
};

export type CustomerMasked = { id: string; displayName: string };

export type CustomerList =
  | { access: "full"; customers: CustomerFull[]; hasMore: boolean }
  | { access: "masked"; customers: CustomerMasked[]; hasMore: boolean };

type CustomerRow = { id: string; name: string; email: string | null; phone: string | null; preferred_locale: string | null };

const FULL_COLUMNS = "id, name, email, phone, preferred_locale";
const SEARCH_COLUMNS = ["name", "email", "phone"] as const;

function toCustomer(row: CustomerRow): CustomerFull {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    preferredLocale: row.preferred_locale === "es" || row.preferred_locale === "en" ? row.preferred_locale : null,
  };
}

function toRow(input: CustomerInput) {
  return { name: input.name, email: input.email, phone: input.phone, preferred_locale: input.preferredLocale };
}

/** True when the context's role reads full customer data (names, emails, phones). */
export function hasFullCustomerAccess(ctx: OperatorContext): boolean {
  return can(ctx.role, "customers.read_full");
}

function requireWrite(ctx: OperatorContext): void {
  if (!can(ctx.role, "customers.write")) throw new ForbiddenError("customers.write");
}

/**
 * The operator's customers, ordered by name, optionally filtered by a search
 * term (name, email or phone for full access; the masked name otherwise).
 * Fetches one row past the limit to report `hasMore`.
 */
export async function listCustomers(ctx: OperatorContext, options: { query?: string } = {}): Promise<CustomerList> {
  const supabase = await createClient();
  const term = options.query ?? "";

  if (hasFullCustomerAccess(ctx)) {
    let request = supabase
      .from("customers")
      .select(FULL_COLUMNS)
      .eq("operator_id", ctx.operator.id)
      .order("name")
      .order("id")
      .limit(CUSTOMER_LIST_LIMIT + 1);
    const filter = customerSearchFilter(term, SEARCH_COLUMNS);
    if (filter) request = request.or(filter);
    const { data, error } = await request;
    if (error) throw error;
    const rows = data ?? [];
    return {
      access: "full",
      customers: rows.slice(0, CUSTOMER_LIST_LIMIT).map(toCustomer),
      hasMore: rows.length > CUSTOMER_LIST_LIMIT,
    };
  }

  let request = supabase
    .from("customer_display")
    .select("customer_id, display_name")
    .eq("operator_id", ctx.operator.id)
    .order("display_name")
    .order("customer_id")
    .limit(CUSTOMER_LIST_LIMIT + 1);
  if (customerSearchFilter(term, ["display_name"])) request = request.ilike("display_name", likeContains(term));
  const { data, error } = await request;
  if (error) throw error;
  const rows = data ?? [];
  return {
    access: "masked",
    customers: rows.slice(0, CUSTOMER_LIST_LIMIT).map((row) => ({ id: row.customer_id, displayName: row.display_name })),
    hasMore: rows.length > CUSTOMER_LIST_LIMIT,
  };
}

/** One customer with full data, or `NotFoundError` (also for another operator's id). Full-access roles only. */
export async function getCustomer(ctx: OperatorContext, id: string): Promise<CustomerFull> {
  if (!hasFullCustomerAccess(ctx)) throw new ForbiddenError("customers.read_full");
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("customers")
    .select(FULL_COLUMNS)
    .eq("operator_id", ctx.operator.id)
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new NotFoundError("customer");
  return toCustomer(data);
}

/**
 * Masked names for the given customer ids of the active operator (the second
 * query of the KTD4 pattern). Ids of other operators are simply absent.
 */
export async function getCustomerDisplays(ctx: OperatorContext, ids: readonly string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  const names = new Map<string, string>();
  if (unique.length === 0) return names;
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("customer_display")
    .select("customer_id, display_name")
    .eq("operator_id", ctx.operator.id)
    .in("customer_id", unique);
  if (error) throw error;
  for (const row of data ?? []) names.set(row.customer_id, row.display_name);
  return names;
}

/** Creates a customer of the active operator; `operator_id` comes from ctx only. */
export async function createCustomer(ctx: OperatorContext, input: CustomerInput): Promise<CustomerFull> {
  requireWrite(ctx);
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("customers")
    .insert({ ...toRow(input), operator_id: ctx.operator.id })
    .select(FULL_COLUMNS)
    .single();
  if (error) throw error;
  return toCustomer(data);
}

/** Updates a customer of the active operator; zero affected rows is `NotFoundError` (found-check, KTD9). */
export async function updateCustomer(ctx: OperatorContext, id: string, input: CustomerInput): Promise<CustomerFull> {
  requireWrite(ctx);
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("customers")
    .update(toRow(input))
    .eq("operator_id", ctx.operator.id)
    .eq("id", id)
    .select(FULL_COLUMNS);
  if (error) throw error;
  const [row] = data ?? [];
  if (!row) throw new NotFoundError("customer");
  return toCustomer(row);
}
