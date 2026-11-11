"use server";

// Members actions (U4, R9, R12, KTD8). Server actions are public POST
// endpoints: each one resolves the context and checks the permission first,
// validates a plain object with Zod (ids as uuids) and found-checks every
// targeted write. The operator id comes from `ctx` only.
//
// Invite (staff) follows the "Invite and confirm" sequence: inviteUserByEmail
// creates the user and mails the invite; when the email already has a
// confirmed account (`email_exists`) the user id comes from `profiles` by
// lower(email), no link is minted, the membership is inserted under the
// administrador's own session, and a sign-in link is sent. Every email
// failure answers with the same `email_failed` state and leaves no membership
// behind, and the success state is the same whether the email had an account
// or not (R9).
import { changeRoleSchema, inviteMemberSchema, membershipIdSchema } from "@cupo/shared/schemas/members";
import { refresh } from "next/cache";
import { field, requestOrigin } from "@/lib/auth/request";
import { findUserIdByEmail, inviteStaffByEmail, sendSignInLink } from "@/lib/auth/access";
import { requireOperatorContext, type OperatorContext } from "@/lib/dal/context";
import { NotFoundError } from "@/lib/dal/errors";
import { deleteMembership, getMembership, insertMembership, updateMembershipRole } from "@/lib/dal/members";
import { logger } from "@/lib/logger";
import { errorState, validationState, withValues, type ActionState, type ErrorState } from "@/lib/result";

export type MemberActionState = ActionState;

const EMAIL_FAILED: ErrorState = { status: "error", error: "email_failed" };
const OK = { status: "ok" } as const;

/** Removes a membership this action created, after its email failed. */
async function undoMembership(ctx: OperatorContext, membershipId: string): Promise<void> {
  try {
    await deleteMembership(ctx, membershipId);
  } catch (error) {
    logger.error("removing the membership of a failed invite failed", {
      operatorId: ctx.operator.id,
      extra: { kind: error instanceof Error ? error.name : typeof error },
    });
  }
}

export async function inviteMemberAction(_previous: MemberActionState, formData: FormData): Promise<MemberActionState> {
  const values = { email: field(formData, "email"), role: field(formData, "role") };
  try {
    const ctx = await requireOperatorContext("members.invite");
    const parsed = inviteMemberSchema.safeParse(values);
    if (!parsed.success) return withValues(validationState(parsed.error), values);
    const { email, role } = parsed.data;
    const redirectTo = await requestOrigin();

    const invite = await inviteStaffByEmail(email, redirectTo);
    if (invite.kind === "failed") return withValues(EMAIL_FAILED, values);

    const userId = invite.kind === "invited" ? invite.userId : await findUserIdByEmail(email);
    if (!userId) {
      // email_exists without a profile row: the mirror trigger failed.
      logger.error("existing account has no profile", { operatorId: ctx.operator.id });
      return withValues({ status: "error", error: "unexpected" }, values);
    }

    const membershipId = await insertMembership(ctx, { userId, role });

    if (invite.kind === "exists" && !(await sendSignInLink(email, redirectTo))) {
      await undoMembership(ctx, membershipId);
      return withValues(EMAIL_FAILED, values);
    }
  } catch (error) {
    return withValues(errorState(error), values);
  }
  refresh();
  return OK;
}

export async function changeRoleAction(_previous: MemberActionState, formData: FormData): Promise<MemberActionState> {
  try {
    const ctx = await requireOperatorContext("members.write");
    const parsed = changeRoleSchema.safeParse({ membershipId: field(formData, "membershipId"), role: field(formData, "role") });
    if (!parsed.success) return validationState(parsed.error);
    await updateMembershipRole(ctx, parsed.data.membershipId, parsed.data.role);
  } catch (error) {
    return errorState(error);
  }
  refresh();
  return OK;
}

export async function removeMemberAction(_previous: MemberActionState, formData: FormData): Promise<MemberActionState> {
  try {
    const ctx = await requireOperatorContext("members.write");
    const parsed = membershipIdSchema.safeParse({ membershipId: field(formData, "membershipId") });
    if (!parsed.success) return validationState(parsed.error);
    await deleteMembership(ctx, parsed.data.membershipId);
  } catch (error) {
    return errorState(error);
  }
  refresh();
  return OK;
}

/**
 * Sends the member a new access email: the invite again for a staff invitee
 * who never accepted it (Supabase re-sends it to an unconfirmed user), a
 * sign-in link otherwise. Guías only ever get sign-in links (KTD8).
 */
export async function resendAccessAction(_previous: MemberActionState, formData: FormData): Promise<MemberActionState> {
  try {
    const ctx = await requireOperatorContext("members.invite");
    const parsed = membershipIdSchema.safeParse({ membershipId: field(formData, "membershipId") });
    if (!parsed.success) return validationState(parsed.error);
    const membership = await getMembership(ctx, parsed.data.membershipId);
    if (!membership) throw new NotFoundError("membership");
    if (!membership.email) return EMAIL_FAILED;
    const redirectTo = await requestOrigin();

    if (membership.role !== "guia") {
      const invite = await inviteStaffByEmail(membership.email, redirectTo);
      if (invite.kind === "invited") return OK;
      if (invite.kind === "failed") return EMAIL_FAILED;
    }
    if (!(await sendSignInLink(membership.email, redirectTo))) return EMAIL_FAILED;
  } catch (error) {
    return errorState(error);
  }
  return OK;
}
