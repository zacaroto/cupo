// Page-level wrapper of requireOperatorContext: turns the DAL errors into
// navigation instead of an error page. Server actions call
// requireOperatorContext directly and map errors with result.ts.
import "server-only";
import { notFound } from "next/navigation";
import type { Action } from "@cupo/shared/permissions";
import { redirect } from "@/i18n/navigation";
import type { Locale } from "@/i18n/routing";
import { requireOperatorContext, type OperatorContext } from "./context";
import { ForbiddenError, UnauthenticatedError } from "./errors";

export async function requirePageContext(locale: Locale, action?: Action): Promise<OperatorContext> {
  try {
    return await requireOperatorContext(action);
  } catch (error) {
    if (error instanceof UnauthenticatedError) return redirect({ href: "/login", locale });
    if (error instanceof ForbiddenError) {
      // No context at all is R5's no-access page; a missing permission is a
      // 404 so the page does not reveal that the section exists.
      if (error.reason === "no_context") return redirect({ href: "/no-access", locale });
      notFound();
    }
    throw error;
  }
}
