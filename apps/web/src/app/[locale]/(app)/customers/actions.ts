"use server";

// Customer server actions (plan U9, R10, R26, KTD9). Server actions are public
// POST endpoints: each one resolves the context and checks `customers.write`
// first, validates a plain object with the shared Zod schema, stamps
// `operator_id` from the context (inside the DAL) and found-checks every
// targeted write. Customer data is never logged.
import { customerInputSchema, customerUpdateSchema } from "@cupo/shared/schemas/customers";
import { refresh } from "next/cache";
import { redirect } from "@/i18n/navigation";
import { field, localeFrom } from "@/lib/auth/request";
import { requireOperatorContext } from "@/lib/dal/context";
import { createCustomer, updateCustomer } from "@/lib/dal/customers";
import { errorState, validationState, type ErrorState } from "@/lib/result";

/** What the user typed, echoed back on an error so the form keeps it. */
export type CustomerFormValues = { name: string; email: string; phone: string; preferredLocale: string };

export type CustomerFormState =
  | { status: "idle" }
  | { status: "ok"; data: { id: string; name: string } }
  | (ErrorState & { values?: CustomerFormValues });

function formValues(formData: FormData): CustomerFormValues {
  return {
    name: field(formData, "name"),
    email: field(formData, "email"),
    phone: field(formData, "phone"),
    preferredLocale: field(formData, "preferredLocale"),
  };
}

/**
 * The state for a failed write. The only unique constraint a customer write
 * can meet is the per-operator email (R26), so `duplicate` is shown on that
 * field.
 */
function writeErrorState(error: unknown, values: CustomerFormValues): CustomerFormState {
  const state = errorState(error);
  if (state.error === "duplicate") {
    return { ...state, error: "invalid", fieldErrors: { email: "validation.emailTaken" }, values };
  }
  return { ...state, values };
}

/** Creates a customer in the active operator. Also used by the reservation form's inline create (U6). */
export async function createCustomerAction(_previous: CustomerFormState, formData: FormData): Promise<CustomerFormState> {
  const values = formValues(formData);
  try {
    const ctx = await requireOperatorContext("customers.write");
    const parsed = customerInputSchema.safeParse(values);
    if (!parsed.success) return { ...validationState(parsed.error), values };
    const customer = await createCustomer(ctx, parsed.data);
    refresh();
    return { status: "ok", data: { id: customer.id, name: customer.name } };
  } catch (error) {
    return writeErrorState(error, values);
  }
}

/** Updates a customer of the active operator, then returns to the list. */
export async function updateCustomerAction(_previous: CustomerFormState, formData: FormData): Promise<CustomerFormState> {
  const locale = localeFrom(formData);
  const values = formValues(formData);
  try {
    const ctx = await requireOperatorContext("customers.write");
    const parsed = customerUpdateSchema.safeParse({ ...values, id: field(formData, "id") });
    if (!parsed.success) return { ...validationState(parsed.error), values };
    const { id, ...input } = parsed.data;
    await updateCustomer(ctx, id, input);
  } catch (error) {
    return writeErrorState(error, values);
  }
  return redirect({ href: "/customers", locale });
}
