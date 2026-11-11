// Errors thrown by the Data Access Layer. `apps/web/src/lib/result.ts` maps
// them to action states; pages let them bubble (the proxy and the (app)
// layout redirect before a page normally gets here).
import type { Action } from "@cupo/shared/permissions";

/** No valid Supabase session on the request. */
export class UnauthenticatedError extends Error {
  override readonly name = "UnauthenticatedError";
  readonly code = "unauthenticated" as const;

  constructor() {
    super("unauthenticated");
  }
}

/**
 * A session exists but there is no active operator context (`no_context`,
 * R5), or the active role lacks the action (`missing_permission`).
 */
export class ForbiddenError extends Error {
  override readonly name = "ForbiddenError";
  readonly code = "forbidden" as const;
  readonly reason: "no_context" | "missing_permission";

  constructor(readonly action?: Action) {
    super(action ? `forbidden: ${action}` : "forbidden: no operator context");
    this.reason = action ? "missing_permission" : "no_context";
  }
}

/** A targeted row does not exist for this operator (found-check after a write). */
export class NotFoundError extends Error {
  override readonly name = "NotFoundError";
  readonly code = "not_found" as const;

  constructor(readonly entity?: string) {
    super(entity ? `not found: ${entity}` : "not found");
  }
}
