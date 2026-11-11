"use server";

// Guide registry actions (U4, R19, KTD8). Same rules as every server action:
// context and permission first, Zod on a plain object (ids as uuids), the
// operator id from `ctx`, a found-check on every targeted write.
import { emailField } from "@cupo/shared/schemas/auth";
import { guideActiveSchema, guideIdSchema, guideSchema, guideUpdateSchema } from "@cupo/shared/schemas/guides";
import { refresh } from "next/cache";
import { redirect } from "@/i18n/navigation";
import { field, localeFrom, requestOrigin } from "@/lib/auth/request";
import { deleteCreatedAccount, ensureGuideAccount, sendSignInLink } from "@/lib/auth/access";
import { requireOperatorContext } from "@/lib/dal/context";
import { NotFoundError } from "@/lib/dal/errors";
import { createGuide, getGuide, linkGuideAccount, setGuideActive, updateGuide } from "@/lib/dal/guides";
import { deleteMembership, findMembershipOfUser, insertMembership } from "@/lib/dal/members";
import { logger } from "@/lib/logger";
import { errorState, validationState, withValues, type ActionState, type ErrorState } from "@/lib/result";

export type GuideActionState = ActionState;

const OK = { status: "ok" } as const;

function guideFields(formData: FormData) {
  return {
    name: field(formData, "name"),
    email: field(formData, "email"),
    phone: field(formData, "phone"),
    languages: field(formData, "languages"),
    specialties: field(formData, "specialties"),
    maxDailyHours: field(formData, "maxDailyHours"),
  };
}

/** Creates a guide and opens its record, where access can be sent. */
export async function createGuideAction(_previous: GuideActionState, formData: FormData): Promise<GuideActionState> {
  const locale = localeFrom(formData);
  const values = guideFields(formData);
  let guideId: string;
  try {
    const ctx = await requireOperatorContext("guides.write");
    const parsed = guideSchema.safeParse(values);
    if (!parsed.success) return withValues(validationState(parsed.error), values);
    guideId = await createGuide(ctx, parsed.data);
  } catch (error) {
    return withValues(errorState(error), values);
  }
  return redirect({ href: `/guides/${guideId}`, locale });
}

export async function updateGuideAction(_previous: GuideActionState, formData: FormData): Promise<GuideActionState> {
  const values = guideFields(formData);
  try {
    const ctx = await requireOperatorContext("guides.write");
    const parsed = guideUpdateSchema.safeParse({ guideId: field(formData, "guideId"), ...values });
    if (!parsed.success) return withValues(validationState(parsed.error), values);
    const { guideId, ...input } = parsed.data;
    await updateGuide(ctx, guideId, input);
  } catch (error) {
    return withValues(errorState(error), values);
  }
  refresh();
  return OK;
}

/** Deactivating also deletes the guide's guía membership in the same statement (database trigger). */
export async function setGuideActiveAction(_previous: GuideActionState, formData: FormData): Promise<GuideActionState> {
  try {
    const ctx = await requireOperatorContext("guides.write");
    const parsed = guideActiveSchema.safeParse({ guideId: field(formData, "guideId"), active: field(formData, "active") });
    if (!parsed.success) return validationState(parsed.error);
    await setGuideActive(ctx, parsed.data.guideId, parsed.data.active);
  } catch (error) {
    return errorState(error);
  }
  refresh();
  return OK;
}

type Undo = () => Promise<void>;

async function runUndo(steps: Undo[], operatorId: string): Promise<void> {
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      logger.error("undoing a failed guide access step failed", {
        operatorId,
        extra: { kind: error instanceof Error ? error.name : typeof error },
      });
    }
  }
}

/**
 * Gives a guide access (KTD8, plan U4 step 4): the account for the guide's
 * email is found in `profiles` or created with `email_confirm: true` (no
 * invite mail), linked to the guide, given the guía membership, and sent a
 * magic link. Sending again to a guide who already has access only re-sends
 * the link. On any failure the steps this call made are undone (membership,
 * link, created account), newest first.
 */
export async function sendGuideAccessAction(_previous: GuideActionState, formData: FormData): Promise<GuideActionState> {
  const undo: Undo[] = [];
  let operatorId = "";
  try {
    const ctx = await requireOperatorContext("members.invite");
    operatorId = ctx.operator.id;
    const parsed = guideIdSchema.safeParse({ guideId: field(formData, "guideId") });
    if (!parsed.success) return validationState(parsed.error);
    const guide = await getGuide(ctx, parsed.data.guideId);
    if (!guide) throw new NotFoundError("guide");
    if (!guide.active) return { status: "error", error: "guide_inactive" };
    // Re-validate the stored contact email before using it as an account email.
    const email = emailField.safeParse(guide.email ?? "");
    if (!email.success) return { status: "error", error: "guide_email_required" };
    const redirectTo = await requestOrigin();

    const account = await ensureGuideAccount(email.data, guide.name);
    if (!account) return { status: "error", error: "unexpected" };
    const { userId } = account;
    if (account.created) undo.unshift(() => deleteCreatedAccount(userId));

    const existing = await findMembershipOfUser(ctx, userId);
    if (existing && existing.role !== "guia") {
      // A staff member of this operator: one membership per user and operator.
      await runUndo(undo, operatorId);
      return { status: "error", error: "duplicate" };
    }

    if (guide.userId !== userId) {
      const previousUserId = guide.userId;
      await linkGuideAccount(ctx, guide.id, userId);
      undo.unshift(() => linkGuideAccount(ctx, guide.id, previousUserId));
    }
    if (!existing) {
      const membershipId = await insertMembership(ctx, { userId, role: "guia" });
      undo.unshift(() => deleteMembership(ctx, membershipId));
    }

    if (!(await sendSignInLink(email.data, redirectTo))) {
      await runUndo(undo, operatorId);
      return { status: "error", error: "email_failed" } satisfies ErrorState;
    }
  } catch (error) {
    await runUndo(undo, operatorId);
    return errorState(error);
  }
  refresh();
  return OK;
}
