// Zod 4 schemas for the members flows (U4, R9, R12). Plain objects in (the
// server action converts FormData first); message keys out, translated under
// the `members` namespace. Ids are validated as uuids because server actions
// are public POST endpoints (KTD9).
import { z } from "zod";
import { ROLES, STAFF_ROLES } from "../permissions";
import { emailField } from "./auth";

/** Staff are invited by email; guías get access from their guide record instead. */
export const inviteMemberSchema = z.object({
  email: emailField,
  role: z.enum(STAFF_ROLES, { error: "validation.roleInvalid" }),
});

export const membershipIdSchema = z.object({
  membershipId: z.uuid({ error: "validation.idInvalid" }),
});

/** Any role; the database rejects `guia` without a linked guide (guide_not_linked). */
export const changeRoleSchema = membershipIdSchema.extend({
  role: z.enum(ROLES as [(typeof ROLES)[number], ...(typeof ROLES)[number][]], { error: "validation.roleInvalid" }),
});

export type InviteMemberInput = z.infer<typeof inviteMemberSchema>;
export type MembershipIdInput = z.infer<typeof membershipIdSchema>;
export type ChangeRoleInput = z.infer<typeof changeRoleSchema>;
