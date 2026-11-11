import { describe, expect, it } from "vitest";
import { guideActiveSchema, guideIdSchema, guideSchema, guideUpdateSchema } from "./guides";

const ID = "9a100000-0000-4000-8000-00000000000a";
const blank = { name: "Ana", email: "", phone: "", languages: "", specialties: "", maxDailyHours: "" };

function issues(result: { success: boolean; error?: { issues: Array<{ path: PropertyKey[]; message: string }> } }) {
  return (result.error?.issues ?? []).map((issue) => `${issue.path.join(".")}:${issue.message}`);
}

describe("guide schemas", () => {
  it("turns empty optionals into null and empty lists into []", () => {
    expect(guideSchema.parse(blank)).toEqual({
      name: "Ana",
      email: null,
      phone: null,
      languages: [],
      specialties: [],
      maxDailyHours: null,
    });
  });

  it("normalizes the email, trims and de-duplicates the lists and reads the hours", () => {
    expect(
      guideSchema.parse({
        name: "  Ana Mora ",
        email: " Ana@Cupo.Test ",
        phone: " +506 8888-0001 ",
        languages: "es, en ,es,, ",
        specialties: "senderismo",
        maxDailyHours: "8",
      }),
    ).toEqual({
      name: "Ana Mora",
      email: "ana@cupo.test",
      phone: "+506 8888-0001",
      languages: ["es", "en"],
      specialties: ["senderismo"],
      maxDailyHours: 8,
    });
  });

  it("rejects a missing name, a bad email or phone and hours outside 1..24", () => {
    expect(issues(guideSchema.safeParse({ ...blank, name: "  " }))).toEqual(["name:validation.nameRequired"]);
    expect(issues(guideSchema.safeParse({ ...blank, email: "ana@" }))).toEqual(["email:validation.emailInvalid"]);
    expect(issues(guideSchema.safeParse({ ...blank, phone: "call me" }))).toEqual(["phone:validation.phoneInvalid"]);
    for (const hours of ["0", "25", "1.5", "-1", "abc"]) {
      expect(issues(guideSchema.safeParse({ ...blank, maxDailyHours: hours })), hours).toEqual(["maxDailyHours:validation.hoursInvalid"]);
    }
    expect(guideSchema.parse({ ...blank, maxDailyHours: "24" }).maxDailyHours).toBe(24);
  });

  it("bounds the lists", () => {
    const many = Array.from({ length: 21 }, (_, i) => `l${i}`).join(",");
    expect(issues(guideSchema.safeParse({ ...blank, languages: many }))).toEqual(["languages:validation.listTooLong"]);
    expect(issues(guideSchema.safeParse({ ...blank, specialties: "x".repeat(41) }))).toEqual([
      "specialties.0:validation.listItemTooLong",
    ]);
  });

  it("validates guide ids and the active flag", () => {
    expect(guideIdSchema.safeParse({ guideId: ID }).success).toBe(true);
    expect(issues(guideIdSchema.safeParse({ guideId: "x" }))).toEqual(["guideId:validation.idInvalid"]);
    expect(guideUpdateSchema.parse({ guideId: ID, ...blank }).guideId).toBe(ID);
    expect(guideActiveSchema.parse({ guideId: ID, active: "false" })).toEqual({ guideId: ID, active: false });
    expect(guideActiveSchema.safeParse({ guideId: ID, active: "yes" }).success).toBe(false);
  });
});
