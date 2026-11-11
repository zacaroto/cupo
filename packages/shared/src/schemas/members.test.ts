import { describe, expect, it } from "vitest";
import { changeRoleSchema, inviteMemberSchema, membershipIdSchema } from "./members";

const ID = "0a000000-0000-4000-8000-00000000000a";

function issues(result: { success: boolean; error?: { issues: Array<{ path: PropertyKey[]; message: string }> } }) {
  return (result.error?.issues ?? []).map((issue) => `${issue.path.join(".")}:${issue.message}`);
}

describe("members schemas", () => {
  it("normalizes the invite email and accepts every staff role", () => {
    for (const role of ["administrador", "reservas", "contabilidad"]) {
      expect(inviteMemberSchema.parse({ email: " New@Cupo.Test ", role })).toEqual({ email: "new@cupo.test", role });
    }
  });

  it("refuses to invite a guía by email (guías get access from their guide record)", () => {
    expect(issues(inviteMemberSchema.safeParse({ email: "g@cupo.test", role: "guia" }))).toEqual(["role:validation.roleInvalid"]);
    expect(issues(inviteMemberSchema.safeParse({ email: "nope", role: "owner" }))).toEqual([
      "email:validation.emailInvalid",
      "role:validation.roleInvalid",
    ]);
  });

  it("validates membership ids as uuids", () => {
    expect(membershipIdSchema.safeParse({ membershipId: ID }).success).toBe(true);
    for (const bad of ["", "1", `${ID}'--`, `${ID} `]) {
      expect(issues(membershipIdSchema.safeParse({ membershipId: bad })), bad).toEqual(["membershipId:validation.idInvalid"]);
    }
  });

  it("accepts any of the four roles on a role change and nothing else", () => {
    for (const role of ["administrador", "reservas", "contabilidad", "guia"]) {
      expect(changeRoleSchema.parse({ membershipId: ID, role })).toEqual({ membershipId: ID, role });
    }
    expect(issues(changeRoleSchema.safeParse({ membershipId: ID, role: "admin" }))).toEqual(["role:validation.roleInvalid"]);
  });
});
